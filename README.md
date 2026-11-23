# Random Name Picker


This is a random name picker with a Node.js API that stores the active name list in MinIO.

## Setup

1. Install Node.js 20 or newer.
2. Configure `.env` with `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_REGION`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY`.
3. In the MinIO bucket, create `names.txt` and `namesbk.txt` as UTF-8 text files with one name per line. `namesbk.txt` is the reset source.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

Give the MinIO access key only `GetObject` access to `namesbk.txt` and `GetObject`/`PutObject` access to `names.txt`. The server reads and writes MinIO; do not put MinIO credentials in `index.html` or expose `.env`. Deploy the Node server (not just the static files) and place it behind appropriate access controls before using it with a publicly reachable bucket.

## License

MIT License
