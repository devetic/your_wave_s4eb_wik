import express, { Request, Response } from "express";
import { createReadStream } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { Readable } from "stream";
import {
  getDirectAudioUrlFromVideoId,
  parseStreamRef,
  resolveBridgeInput,
} from "./src/bridgeService";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MUSIC_DIR = process.env.MUSIC_DIR || path.resolve(process.cwd(), "music");
const WEB_DIST_DIR = path.resolve(process.cwd(), "web-dist");
const DATA_DIR = path.resolve(process.cwd(), "data");
const DOWNLOADS_DIR = path.resolve(process.cwd(), "downloads");
const PLAYLISTS_FILE = path.join(DATA_DIR, "playlists.json");

type ScanResult = {
  fileName: string;
  relativePath: string;
  fullPath: string;
  artist: string | null;
  title: string | null;
  albumArtBase64: string | null;
  albumArtMimeType: string | null;
};

type PlaylistSong = {
  id: string;
  source: "local" | "youtube" | "spotify";
  title: string;
  artist: string;
  relativePath?: string;
  streamRef?: string;
  videoId?: string;
  thumbnail?: string | null;
  offlineFileName?: string;
};

type Playlist = {
  id: string;
  name: string;
  songs: PlaylistSong[];
  createdAt: string;
  updatedAt: string;
};

app.use(express.json({ limit: "1mb" }));

function isSupportedAudioFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".mp3" || ext === ".flac";
}

async function ensureAppDirs(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
}

async function readPlaylists(): Promise<Playlist[]> {
  await ensureAppDirs();
  try {
    const raw = await fs.readFile(PLAYLISTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Playlist[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writePlaylists(playlists: Playlist[]): Promise<void> {
  await ensureAppDirs();
  await fs.writeFile(PLAYLISTS_FILE, JSON.stringify(playlists, null, 2), "utf8");
}

async function scanMusicFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await scanMusicFilesRecursively(fullPath);
      files.push(...nestedFiles);
      continue;
    }

    if (entry.isFile() && isSupportedAudioFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeAndValidatePath(inputPath: string): string | null {
  const decoded = decodeURIComponent(inputPath);
  const normalized = path.normalize(decoded);
  const resolved = path.resolve(MUSIC_DIR, normalized);
  const relative = path.relative(MUSIC_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return resolved;
}

function safeFileName(input: string): string {
  return input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 140);
}

app.get("/scan", async (_req: Request, res: Response) => {
  try {
    const musicFiles = await scanMusicFilesRecursively(MUSIC_DIR);

    const withMetadata: ScanResult[] = await Promise.all(
      musicFiles.map(async (filePath) => {
        let artist: string | null = null;
        let title: string | null = null;
        let albumArtBase64: string | null = null;
        let albumArtMimeType: string | null = null;

        try {
          const { parseFile } = await import("music-metadata");
          const metadata = await parseFile(filePath);
          artist = metadata.common.artist ?? null;
          title = metadata.common.title ?? path.basename(filePath);

          const picture = metadata.common.picture?.[0];
          if (picture) {
            albumArtBase64 = Buffer.from(picture.data).toString("base64");
            albumArtMimeType = picture.format || "image/jpeg";
          }
        } catch {
          title = path.basename(filePath);
        }

        return {
          fileName: path.basename(filePath),
          relativePath: path.relative(MUSIC_DIR, filePath).split(path.sep).join("/"),
          fullPath: filePath,
          artist,
          title,
          albumArtBase64,
          albumArtMimeType,
        };
      })
    );

    res.json({ rootDirectory: MUSIC_DIR, count: withMetadata.length, files: withMetadata });
  } catch (error) {
    res.status(500).json({ error: "Failed to scan music directory.", details: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/stream/:filename", async (req: Request, res: Response) => {
  const requested = req.params.filename;
  const filePath = normalizeAndValidatePath(requested);

  if (!filePath) {
    res.status(400).json({ error: "Invalid filename path." });
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || !isSupportedAudioFile(filePath)) {
      res.status(404).json({ error: "Audio file not found." });
      return;
    }

    const fileSize = stats.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".flac" ? "audio/flac" : "audio/mpeg";

    if (!range) {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType, "Accept-Ranges": "bytes" });
      createReadStream(filePath).pipe(res);
      return;
    }

    const matches = /bytes=(\d*)-(\d*)/.exec(range);
    if (!matches) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      return;
    }

    const start = matches[1] ? Number(matches[1]) : 0;
    const end = matches[2] ? Number(matches[2]) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      return;
    }

    const chunkEnd = Math.min(end, fileSize - 1);
    const chunkSize = chunkEnd - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${chunkEnd}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });

    createReadStream(filePath, { start, end: chunkEnd }).pipe(res);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "Audio file not found." });
      return;
    }
    res.status(500).json({ error: "Failed to stream audio file.", details: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/bridge/resolve", async (req: Request, res: Response) => {
  const input = String(req.query.q || req.query.input || "").trim();
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  if (!input) {
    res.status(400).json({ error: "Missing query parameter: q" });
    return;
  }

  try {
    const results = await resolveBridgeInput(input, { limit, offset });
    const hasMore = results.length === Math.max(1, Math.min(limit, 200));
    res.json({ query: input, count: results.length, limit, offset, hasMore, results });
  } catch (error) {
    res.status(500).json({ error: "Failed to resolve bridge input.", details: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/bridge/stream/:streamRef", async (req: Request, res: Response) => {
  const streamRef = req.params.streamRef;

  try {
    const parsed = parseStreamRef(streamRef);
    const audioUrl = await getDirectAudioUrlFromVideoId(parsed.videoId);
    const headers: Record<string, string> = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers["user-agent"]) headers["User-Agent"] = String(req.headers["user-agent"]);
    if (req.headers.accept) headers.Accept = String(req.headers.accept);

    const upstream = await fetch(audioUrl, { headers });
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({
        error: "Upstream bridge stream unavailable.",
        upstreamStatus: upstream.status,
        source: parsed.source,
        videoId: parsed.videoId,
      });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "audio/webm";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const cacheControl = upstream.headers.get("cache-control");
    const acceptRanges = upstream.headers.get("accept-ranges");

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", acceptRanges || "bytes");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);

    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (error) {
    res.status(500).json({
      error: "Failed to bridge stream.",
      details: error instanceof Error ? error.message : "Unknown error",
      code: "BRIDGE_STREAM_FAILURE",
    });
  }
});

app.get("/playlists", async (_req: Request, res: Response) => {
  const playlists = await readPlaylists();
  res.json({ count: playlists.length, playlists });
});

app.get("/playlists/:id", async (req: Request, res: Response) => {
  const playlists = await readPlaylists();
  const playlist = playlists.find((p) => p.id === req.params.id);
  if (!playlist) {
    res.status(404).json({ error: "Playlist not found." });
    return;
  }
  res.json({ playlist });
});

app.post("/playlists", async (req: Request, res: Response) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "Playlist name is required." });
    return;
  }

  const playlists = await readPlaylists();
  const duplicate = playlists.some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    res.status(409).json({ error: "Playlist with this name already exists." });
    return;
  }

  const now = new Date().toISOString();
  const playlist: Playlist = {
    id: `pl_${Date.now()}`,
    name,
    songs: [],
    createdAt: now,
    updatedAt: now,
  };

  playlists.push(playlist);
  await writePlaylists(playlists);
  res.status(201).json({ playlist });
});

app.patch("/playlists/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  const name = String(req.body?.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "Playlist name is required." });
    return;
  }

  const playlists = await readPlaylists();
  const target = playlists.find((p) => p.id === id);
  if (!target) {
    res.status(404).json({ error: "Playlist not found." });
    return;
  }

  const duplicate = playlists.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    res.status(409).json({ error: "Playlist with this name already exists." });
    return;
  }

  target.name = name;
  target.updatedAt = new Date().toISOString();
  await writePlaylists(playlists);
  res.json({ playlist: target });
});

app.delete("/playlists/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  const playlists = await readPlaylists();
  const target = playlists.find((p) => p.id === id);
  if (!target) {
    res.status(404).json({ error: "Playlist not found." });
    return;
  }

  const next = playlists.filter((p) => p.id !== id);
  await writePlaylists(next);
  res.json({ deletedId: id, count: next.length });
});

app.post("/playlists/:id/songs", async (req: Request, res: Response) => {
  const id = req.params.id;
  const song = req.body?.song as PlaylistSong | undefined;

  if (!song || !song.id || !song.source || !song.title) {
    res.status(400).json({ error: "Invalid song payload." });
    return;
  }

  const playlists = await readPlaylists();
  const target = playlists.find((p) => p.id === id);
  if (!target) {
    res.status(404).json({ error: "Playlist not found." });
    return;
  }

  const exists = target.songs.some((s) => s.id === song.id);
  if (!exists) {
    target.songs.push(song);
  }
  target.updatedAt = new Date().toISOString();

  await writePlaylists(playlists);
  res.json({ playlist: target, added: !exists });
});

app.delete("/playlists/:id/songs/:songId", async (req: Request, res: Response) => {
  const id = req.params.id;
  const songId = decodeURIComponent(req.params.songId || "");
  if (!songId) {
    res.status(400).json({ error: "Song id is required." });
    return;
  }

  const playlists = await readPlaylists();
  const target = playlists.find((p) => p.id === id);
  if (!target) {
    res.status(404).json({ error: "Playlist not found." });
    return;
  }

  const before = target.songs.length;
  target.songs = target.songs.filter((s) => s.id !== songId);
  const removed = before !== target.songs.length;
  if (!removed) {
    res.status(404).json({ error: "Song not found in playlist." });
    return;
  }

  target.updatedAt = new Date().toISOString();
  await writePlaylists(playlists);
  res.json({ playlist: target, removed: true });
});

app.post("/download", async (req: Request, res: Response) => {
  const song = req.body?.song as PlaylistSong | undefined;
  if (!song || !song.id || !song.source || !song.title) {
    res.status(400).json({ error: "Invalid song payload." });
    return;
  }

  await ensureAppDirs();

  try {
    if (song.source === "local") {
      if (!song.relativePath) {
        res.status(400).json({ error: "Local song missing relativePath." });
        return;
      }

      const srcPath = normalizeAndValidatePath(song.relativePath);
      if (!srcPath) {
        res.status(400).json({ error: "Invalid local path." });
        return;
      }

      const ext = path.extname(srcPath) || ".mp3";
      const fileName = `${safeFileName(song.artist || "Unknown")}-${safeFileName(song.title)}${ext}`;
      const destPath = path.join(DOWNLOADS_DIR, fileName);
      await fs.copyFile(srcPath, destPath);

      res.json({
        ok: true,
        mode: "local-copy",
        savedAs: fileName,
        savedPath: destPath,
        songUpdate: { id: song.id, offlineFileName: fileName },
      });
      return;
    }

    const streamRef = song.streamRef;
    if (!streamRef) {
      res.status(400).json({ error: "Bridge song missing streamRef." });
      return;
    }

    const parsed = parseStreamRef(streamRef);
    const audioUrl = await getDirectAudioUrlFromVideoId(parsed.videoId);
    const upstream = await fetch(audioUrl);

    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: "Failed to fetch audio for download." });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "audio/webm";
    const ext = contentType.includes("mpeg") ? ".mp3" : contentType.includes("flac") ? ".flac" : ".webm";
    const fileName = `${safeFileName(song.artist || "Unknown")}-${safeFileName(song.title)}${ext}`;
    const destPath = path.join(DOWNLOADS_DIR, fileName);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    await fs.writeFile(destPath, buffer);

    res.json({
      ok: true,
      mode: "bridge-download",
      savedAs: fileName,
      savedPath: destPath,
      songUpdate: { id: song.id, offlineFileName: fileName },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to download song.", details: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/offline/:fileName", async (req: Request, res: Response) => {
  const normalized = path.basename(req.params.fileName);
  if (!normalized) {
    res.status(400).json({ error: "Invalid file name." });
    return;
  }

  const filePath = path.join(DOWNLOADS_DIR, normalized);
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      res.status(404).json({ error: "Offline file not found." });
      return;
    }

    const range = req.headers.range;
    const fileSize = stats.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".flac" ? "audio/flac" : ext === ".mp3" ? "audio/mpeg" : "audio/webm";

    if (!range) {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    const matches = /bytes=(\d*)-(\d*)/.exec(range);
    if (!matches) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      return;
    }

    const start = matches[1] ? Number(matches[1]) : 0;
    const end = matches[2] ? Number(matches[2]) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      return;
    }

    const chunkEnd = Math.min(end, fileSize - 1);
    const chunkSize = chunkEnd - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${chunkEnd}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });
    createReadStream(filePath, { start, end: chunkEnd }).pipe(res);
  } catch {
    res.status(404).json({ error: "Offline file not found." });
  }
});

app.use(express.static(WEB_DIST_DIR));
app.get("*", async (_req: Request, res: Response) => {
  const indexPath = path.join(WEB_DIST_DIR, "index.html");
  try {
    await fs.access(indexPath);
    res.sendFile(indexPath);
  } catch {
    res.status(503).send("Frontend is not built yet. Run: npm run build:web");
  }
});

app.listen(PORT, () => {
  console.log(`Music backend listening on http://localhost:${PORT}`);
  console.log(`Scanning from MUSIC_DIR: ${MUSIC_DIR}`);
  console.log(`Playlists file: ${PLAYLISTS_FILE}`);
  console.log(`Downloads directory: ${DOWNLOADS_DIR}`);
});
