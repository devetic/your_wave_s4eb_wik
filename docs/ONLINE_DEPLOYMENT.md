# Web-Only Deployment Guide

## Stack

- Frontend: React + Vite (`web-dist`)
- Backend/API: Express (`server.ts`)
- Runtime data (local only): `data/`, `downloads/`, `music/`

## Environment Variables

- `PORT` (optional): backend port, default `3000`
- `MUSIC_DIR` (optional): local music folder path, default `./music`
- `CORS_ORIGIN` (optional): comma-separated frontend origins allowed by backend CORS
  - Backend is strict: origins not listed here are rejected and logged.
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

## Render + Netlify Setup

### 1) Deploy backend on Render

- Use `render.yaml` from repo root.
- Render service details:
  - Build command: `npm install && npm run build`
  - Start command: `npm run start`
- Set environment variables in Render:
  - `CORS_ORIGIN=https://yourwave.netlify.app,https://www.yourwave.netlify.app`
  - `MUSIC_DIR=/opt/render/project/src`
  - If `MUSIC_DIR` is missing/unavailable, `/scan` now returns `200` with an empty list.

### 2) Deploy frontend on Netlify

- Netlify auto-detects `netlify.toml`.
- Build settings:
  - Command: `npm run build:web`
  - Publish directory: `web-dist`
- Add Netlify environment variable:
  - `VITE_API_BASE=https://your-wave-s4eb-wik.onrender.com`

### 3) Verify cross-origin integration

- Open Netlify app and confirm network calls go to Render URL.
- Confirm API responses for `/scan`, `/playlists`, and `/download`.
