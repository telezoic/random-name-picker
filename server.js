import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

dotenv.config();

const requiredVariables = [
  'MINIO_ENDPOINT',
  'MINIO_BUCKET',
  'MINIO_REGION',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
}

const endpoint = new URL(process.env.MINIO_ENDPOINT);
if (!['http:', 'https:'].includes(endpoint.protocol)) {
  throw new Error('MINIO_ENDPOINT must use http:// or https://');
}

const bucket = process.env.MINIO_BUCKET;
const client = new S3Client({
  endpoint: endpoint.toString(),
  region: process.env.MINIO_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
let operationQueue = Promise.resolve();

function withBucketLock(operation) {
  const previousOperation = operationQueue;
  let release;
  operationQueue = new Promise((resolve) => {
    release = resolve;
  });

  return previousOperation.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

async function readObject(key) {
  const result = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  return result.Body.transformToString();
}

function parseNames(contents) {
  return contents.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

async function getNameState() {
  const [namesContents, backupContents] = await Promise.all([
    readObject('names.txt'),
    readObject('namesbk.txt'),
  ]);
  return {
    names: parseNames(namesContents),
    total: parseNames(backupContents).length,
  };
}

async function writeNames(names) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: 'names.txt',
    Body: `${names.join('\n')}${names.length ? '\n' : ''}`,
    ContentType: 'text/plain; charset=utf-8',
  }));
}

async function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) {
      throw new Error('Request body is too large');
    }
  }
  return body ? JSON.parse(body) : {};
}

async function handleApi(request, response, pathname) {
  if (
    request.method === 'POST' &&
    ['/api/remove', '/api/reset'].includes(pathname) &&
    !request.headers['content-type']?.toLowerCase().startsWith('application/json')
  ) {
    await sendJson(response, 415, { error: 'Content-Type must be application/json.' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/names') {
    const state = await withBucketLock(getNameState);
    await sendJson(response, 200, state);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/remove') {
    const body = await readJsonBody(request);
    if (typeof body.name !== 'string' || !body.name.trim()) {
      await sendJson(response, 400, { error: 'A name is required.' });
      return;
    }

    const state = await withBucketLock(async () => {
      const current = parseNames(await readObject('names.txt'));
      const nameIndex = current.indexOf(body.name);
      if (nameIndex === -1) {
        return null;
      }

      current.splice(nameIndex, 1);
      await writeNames(current);
      const total = parseNames(await readObject('namesbk.txt')).length;
      return { names: current, total };
    });

    if (!state) {
      await sendJson(response, 404, { error: 'That name is not in the current list.' });
      return;
    }
    await sendJson(response, 200, state);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/reset') {
    const state = await withBucketLock(async () => {
      const names = parseNames(await readObject('namesbk.txt'));
      await writeNames(names);
      return { names, total: names.length };
    });
    await sendJson(response, 200, state);
    return;
  }

  await sendJson(response, 404, { error: 'Not found.' });
}

function serveStaticFile(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(projectDirectory, `.${requestedPath}`);
  const allowedRoots = ['img', 'css', 'js'].map((directory) =>
    path.resolve(projectDirectory, directory)
  );
  const isIndex = filePath === path.join(projectDirectory, 'index.html');
  const isAsset = allowedRoots.some((root) => filePath.startsWith(`${root}${path.sep}`));

  if (!isIndex && !isAsset) {
    response.writeHead(404);
    response.end('Not found.');
    return;
  }

  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  response.setHeader('Content-Type', contentTypes[path.extname(filePath)] || 'application/octet-stream');
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(404);
    }
    response.end('Not found.');
  });
  if (request.method === 'HEAD') {
    stream.destroy();
    response.end();
  } else {
    stream.pipe(response);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url.pathname);
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      serveStaticFile(request, response, url.pathname);
    } else {
      await sendJson(response, 405, { error: 'Method not allowed.' });
    }
  } catch (error) {
    console.error('Request failed:', error.message);
    if (!response.headersSent) {
      await sendJson(response, error instanceof SyntaxError ? 400 : 500, {
        error: error instanceof SyntaxError ? 'Invalid JSON body.' : 'The request could not be completed.',
      });
    } else {
      response.end();
    }
  }
});

server.listen(port, () => {
  console.log(`Random Name Picker is listening on port ${port}`);
});
