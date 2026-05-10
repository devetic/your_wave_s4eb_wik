# Your Wave (Web-Only)

Web-first music app with React frontend and Express backend.

## Quick Start

```bash
npm install
npm run dev
npm run dev:web
```

Backend runs on `http://localhost:3000`.

## Production

```bash
npm run build:web
npm run build
npm run start
```

## Environment

- `PORT` (default: `3000`)
- `MUSIC_DIR` (default: `./music`)
- `CORS_ORIGIN` (comma-separated allowed frontend origins)
- `VITE_API_BASE` (optional API base URL for frontend)

See [docs/ONLINE_DEPLOYMENT.md](docs/ONLINE_DEPLOYMENT.md) for full deployment notes.
