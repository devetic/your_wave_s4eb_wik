# Web-Only Deployment Guide

## Stack

- Frontend: React + Vite (`web-dist`)
- Backend/API: Express (`server.ts`)
- Runtime data (local only): `data/`, `downloads/`, `music/`

## Environment Variables

- `PORT` (optional): backend port, default `3000`
- `MUSIC_DIR` (optional): local music folder path, default `./music`
- `VITE_API_BASE` (optional): frontend API base URL
  - Dev fallback: `http://<current-host>:3000`
  - Prod fallback: current browser origin (`window.location.origin`)

## Local Development

1. Install dependencies:
   - `npm install`
2. Start backend:
   - `npm run dev`
3. Start frontend dev server:
   - `npm run dev:web`

## Production Build + Run

1. Build frontend:
   - `npm run build:web`
2. Build backend:
   - `npm run build`
3. Run backend (serves API + built frontend):
   - `npm run start`

If `web-dist` is missing, backend returns a message to run `npm run build:web`.

## Online Deploy Checklist

- Set `VITE_API_BASE` only when API is on a different origin.
- Ensure `web-dist` is built during CI/CD before backend start.
- Exclude `data/`, `downloads/`, `music/` from source control.
- Verify endpoints after deploy:
  - `GET /scan`
  - `GET /playlists`
  - `POST /download`
