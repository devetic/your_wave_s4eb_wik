import { useEffect, useMemo, useRef, useState } from "react";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/textfield/outlined-text-field.js";
import { Player } from "./components/Player";
import { SongList, type SongItem } from "./components/SongList";

type LocalScanResponse = {
  files: Array<{
    relativePath: string;
    title: string | null;
    artist: string | null;
    albumArtBase64: string | null;
    albumArtMimeType: string | null;
  }>;
};

type BridgeResolveResponse = {
  count?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  results: Array<{
    id: string;
    source: "youtube" | "spotify";
    title: string;
    artist: string;
    thumbnail: string | null;
    videoId: string;
    streamRef: string;
  }>;
};

type Playlist = {
  id: string;
  name: string;
  songs: SongItem[];
};

type RuntimeSong = SongItem & {
  unavailableReason?: string;
};

type ThemePreference = "system" | "light" | "dark";
type AppView = "library" | "playlists";
type PlaylistDisplay = "grid" | "list";

type PlaybackQueueState = {
  items: SongItem[];
  currentIndex: number;
  lastUpdatedAt: string;
};

const resolvedApiBaseFromEnv = (import.meta.env.VITE_API_BASE || "").trim().replace(/\/+$/, "");
const API_BASE = resolvedApiBaseFromEnv || (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3000` : window.location.origin);
const QUEUE_STORAGE_KEY = "playback-queue-state-v1";
const MAX_STREAM_RETRIES = 2;

const TOKENS_LIGHT: Record<string, string> = {
  "--md-sys-color-background": "#efebe7",
  "--md-sys-color-surface": "#f7f3ef",
  "--md-sys-color-surface-container": "#ddd4cb",
  "--md-sys-color-primary": "#9f4e2f",
  "--md-sys-color-on-primary": "#fff5f0",
  "--md-sys-color-on-surface": "#1f1a17",
  "--md-sys-color-outline": "#6b5c50",
};

const TOKENS_DARK: Record<string, string> = {
  "--md-sys-color-background": "#141210",
  "--md-sys-color-surface": "#1e1a17",
  "--md-sys-color-surface-container": "#2a231e",
  "--md-sys-color-primary": "#c8734f",
  "--md-sys-color-on-primary": "#2b1308",
  "--md-sys-color-on-surface": "#f1e8e0",
  "--md-sys-color-outline": "#8c7869",
};

function isSongPlayable(song: SongItem): boolean {
  if (song.offlineFileName) return true;
  if (song.source === "local") return Boolean(song.relativePath);
  return Boolean(song.streamRef);
}

function toBase64Url(value: string): string {
  const utf8 = new TextEncoder().encode(value);
  let binary = "";
  utf8.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeFallbackStreamRef(song: SongItem): string | undefined {
  if (song.streamRef) return song.streamRef;
  if ((song.source === "youtube" || song.source === "spotify") && song.videoId) {
    const payload = JSON.stringify({
      source: song.source,
      input: song.videoId,
      videoId: song.videoId,
    });
    return toBase64Url(payload);
  }
  return undefined;
}

function normalizePlaylistSong(song: SongItem): RuntimeSong {
  const streamRef = makeFallbackStreamRef(song);

  if (song.source === "local" && !song.relativePath && !song.offlineFileName) {
    return { ...song, streamRef, unavailableReason: "Missing local file path." };
  }

  if ((song.source === "youtube" || song.source === "spotify") && !streamRef && !song.offlineFileName) {
    return { ...song, unavailableReason: "Missing stream reference for bridge track." };
  }

  return { ...song, streamRef };
}

function getQueueStatus(index: number, currentIndex: number): "played" | "now" | "next" {
  if (index < currentIndex) return "played";
  if (index === currentIndex) return "now";
  return "next";
}

function isAbortLikePlaybackError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes("aborted by the user agent") ||
    msg.includes("the play() request was interrupted") ||
    msg.includes("aborterror")
  );
}

export default function App() {
  const [localSongs, setLocalSongs] = useState<SongItem[]>([]);
  const [bridgeSongs, setBridgeSongs] = useState<SongItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [query, setQuery] = useState("lofi focus");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [renamePlaylistName, setRenamePlaylistName] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snackQueue, setSnackQueue] = useState<string[]>([]);
  const [snackOpen, setSnackOpen] = useState(false);
  const [snackText, setSnackText] = useState("");
  const [themePref, setThemePref] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem("theme-pref");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [currentView, setCurrentView] = useState<AppView>("library");
  const [playlistDisplay, setPlaylistDisplay] = useState<PlaylistDisplay>("grid");
  const [currentSong, setCurrentSong] = useState<SongItem | null>(null);
  const [currentQueue, setCurrentQueue] = useState<SongItem[]>([]);
  const [currentQueueIndex, setCurrentQueueIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [unavailableSongIds, setUnavailableSongIds] = useState<Record<string, boolean>>({});
  const [showRail, setShowRail] = useState(true);
  const [showQueuePanel, setShowQueuePanel] = useState(true);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [addSongTarget, setAddSongTarget] = useState<SongItem | null>(null);
  const [addSongPlaylistId, setAddSongPlaylistId] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<SongItem[]>([]);
  const queueIndexRef = useRef<number>(-1);
  const retryCountRef = useRef<Record<string, number>>({});

  const selectedPlaylist = useMemo(
    () => playlists.find((p) => p.id === selectedPlaylistId) || null,
    [playlists, selectedPlaylistId]
  );

  useEffect(() => {
    setRenamePlaylistName(selectedPlaylist?.name || "");
  }, [selectedPlaylist?.id, selectedPlaylist?.name]);

  const mainSongs = useMemo(() => [...localSongs, ...bridgeSongs], [localSongs, bridgeSongs]);

  const enqueueSnack = (msg: string) => setSnackQueue((prev) => [...prev, msg]);

  useEffect(() => {
    queueRef.current = currentQueue;
    queueIndexRef.current = currentQueueIndex;
  }, [currentQueue, currentQueueIndex]);

  useEffect(() => {
    if (!snackOpen && snackQueue.length > 0) {
      const [first, ...rest] = snackQueue;
      setSnackText(first);
      setSnackQueue(rest);
      setSnackOpen(true);
    }
  }, [snackQueue, snackOpen]);

  useEffect(() => {
    if (!snackOpen) return;
    const timer = window.setTimeout(() => setSnackOpen(false), 2600);
    return () => window.clearTimeout(timer);
  }, [snackOpen]);

  useEffect(() => {
    localStorage.setItem("theme-pref", themePref);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolvedDark = themePref === "system" ? prefersDark : themePref === "dark";
    const tokens = resolvedDark ? TOKENS_DARK : TOKENS_LIGHT;
    const root = document.documentElement;
    Object.entries(tokens).forEach(([k, v]) => root.style.setProperty(k, v));
  }, [themePref]);

  const updateSongEverywhere = (songId: string, patch: Partial<SongItem>) => {
    setLocalSongs((prev) => prev.map((s) => (s.id === songId ? { ...s, ...patch } : s)));
    setBridgeSongs((prev) => prev.map((s) => (s.id === songId ? { ...s, ...patch } : s)));
    setPlaylists((prev) => prev.map((pl) => ({ ...pl, songs: pl.songs.map((s) => (s.id === songId ? { ...s, ...patch } : s)) })));
    setCurrentQueue((prev) => prev.map((s) => (s.id === songId ? { ...s, ...patch } : s)));
    setCurrentSong((prev) => (prev && prev.id === songId ? { ...prev, ...patch } : prev));
  };

  const resolvePlaybackSrc = (song: SongItem): string => {
    if (song.offlineFileName) return `${API_BASE}/offline/${encodeURIComponent(song.offlineFileName)}`;
    if (song.source === "local") return `${API_BASE}/stream/${encodeURIComponent(song.relativePath || "")}`;
    return `${API_BASE}/bridge/stream/${encodeURIComponent(song.streamRef || "")}`;
  };

  const playSongWithQueue = async (song: SongItem, queue: SongItem[], forcedIndex?: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    const index = Number.isInteger(forcedIndex) ? Number(forcedIndex) : queue.findIndex((s) => s.id === song.id);
    if (index < 0 || index >= queue.length) return;

    const target = queue[index];
    if (!target || !isSongPlayable(target)) {
      setUnavailableSongIds((prev) => ({ ...prev, [song.id]: true }));
      const msg = `Song '${song.title}' is currently unavailable.`;
      setError(msg);
      enqueueSnack(msg);
      return;
    }

    setError(null);
    const src = resolvePlaybackSrc(target);

    try {
      setCurrentQueue(queue);
      setCurrentQueueIndex(index);
      setCurrentSong(target);
      setUnavailableSongIds((prev) => ({ ...prev, [target.id]: false }));

      audio.src = src;
      await audio.play();
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Unable to start playback.";
      const normalized = message.toLowerCase();
      if (isAbortLikePlaybackError(err)) return;

      const userMessage = normalized.includes("notallowed")
        ? "Playback blocked by browser autoplay policy. Click play again."
        : message;

      setError(userMessage);
      setIsPlaying(false);
      enqueueSnack(userMessage);
    }
  };

  const playSongAtIndex = async (index: number) => {
    const queue = queueRef.current;
    if (index < 0 || index >= queue.length) return;
    await playSongWithQueue(queue[index], queue, index);
  };

  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.preload = "metadata";

    const audio = audioRef.current;
    const onTimeUpdate = () => {
      const ct = audio.currentTime || 0;
      const d = audio.duration || 0;
      setCurrentTime(ct);
      setDuration(d);
      setProgress(d > 0 ? ct / d : 0);
    };

    const onPlay = () => {
      setIsPlaying(true);
      const idx = queueIndexRef.current;
      const playing = idx >= 0 ? queueRef.current[idx] : null;
      if (playing) {
        retryCountRef.current[playing.id] = 0;
      }
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      void playSongAtIndex(queueIndexRef.current + 1);
    };

    const onError = () => {
      const queue = queueRef.current;
      const idx = queueIndexRef.current;
      const broken = idx >= 0 ? queue[idx] : null;
      setIsPlaying(false);
      if (!broken) {
        setError("Playback failed for selected source.");
        enqueueSnack("Playback failed for selected song.");
        return;
      }

      const retries = retryCountRef.current[broken.id] || 0;
      if (retries < MAX_STREAM_RETRIES) {
        retryCountRef.current[broken.id] = retries + 1;
        const attemptNo = retries + 1;
        enqueueSnack(`Retrying '${broken.title}' (${attemptNo}/${MAX_STREAM_RETRIES})...`);
        window.setTimeout(() => {
          void playSongAtIndex(idx);
        }, 350);
        return;
      }

      retryCountRef.current[broken.id] = 0;
      setUnavailableSongIds((prev) => ({ ...prev, [broken.id]: true }));
      setError(`Playback failed after ${MAX_STREAM_RETRIES} retries. Skipping track.`);
      enqueueSnack(`Skipped '${broken.title}' due to playback errors.`);
      void playSongAtIndex(idx + 1);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  useEffect(() => {
    const state: PlaybackQueueState = {
      items: currentQueue,
      currentIndex: currentQueueIndex,
      lastUpdatedAt: new Date().toISOString(),
    };
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(state));
  }, [currentQueue, currentQueueIndex]);

  const loadPlaylists = async () => {
    const res = await fetch(`${API_BASE}/playlists`);
    const data = await res.json();
    const rawItems = (data.playlists || []) as Playlist[];
    const items = rawItems.map((pl) => ({
      ...pl,
      songs: (pl.songs || []).map((song) => normalizePlaylistSong(song)),
    }));
    setPlaylists(items);
    setSelectedPlaylistId((prev) => {
      if (prev && items.some((p) => p.id === prev)) return prev;
      return items[0]?.id || "";
    });
  };

  const loadLocal = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/scan`);
      if (!res.ok) throw new Error("Failed to load local scan");
      const data = (await res.json()) as LocalScanResponse;
      const mapped: SongItem[] = (data.files || []).map((f) => ({
        id: `local:${f.relativePath}`,
        source: "local",
        title: f.title || f.relativePath,
        artist: f.artist,
        subtitle: f.relativePath,
        relativePath: f.relativePath,
        thumbnail: f.albumArtBase64 && f.albumArtMimeType ? `data:${f.albumArtMimeType};base64,${f.albumArtBase64}` : null,
      }));
      setLocalSongs(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Local scan failed.");
    } finally {
      setLoading(false);
    }
  };

  const hydrateQueueState = () => {
    try {
      const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PlaybackQueueState;
      if (!Array.isArray(parsed.items) || typeof parsed.currentIndex !== "number") return;

      const safeItems = parsed.items.filter((song) => song && song.id && song.title);
      const safeIndex = Math.max(-1, Math.min(parsed.currentIndex, safeItems.length - 1));

      setCurrentQueue(safeItems);
      setCurrentQueueIndex(safeIndex);
      setCurrentSong(safeIndex >= 0 ? safeItems[safeIndex] : null);

      const unavailable: Record<string, boolean> = {};
      safeItems.forEach((song) => {
        if (!isSongPlayable(song)) unavailable[song.id] = true;
      });
      setUnavailableSongIds(unavailable);
    } catch {
      // ignore invalid queue cache
    }
  };

  const searchBridge = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const limit = 50;
      const offset = 0;
      const res = await fetch(`${API_BASE}/bridge/resolve?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`);
      if (!res.ok) throw new Error("Bridge search failed");
      const data = (await res.json()) as BridgeResolveResponse;
      const mapped: SongItem[] = (data.results || []).map((v) => ({
        id: v.id,
        source: v.source,
        streamRef: v.streamRef,
        videoId: v.videoId,
        title: v.title,
        artist: v.artist,
        subtitle: v.source === "spotify" ? "Spotify metadata -> YouTube bridge" : "YouTube bridge",
        thumbnail: v.thumbnail,
      }));
      setBridgeSongs(mapped);
      setSearchOffset(offset + mapped.length);
      setSearchHasMore(Boolean(data.hasMore) && mapped.length > 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bridge search failed.");
      enqueueSnack("Bridge search failed.");
    } finally {
      setLoading(false);
    }
  };

  const loadMoreBridge = async () => {
    const q = query.trim();
    if (!q || searchLoadingMore || !searchHasMore) return;
    setSearchLoadingMore(true);
    try {
      const limit = 50;
      const offset = searchOffset;
      const res = await fetch(`${API_BASE}/bridge/resolve?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`);
      if (!res.ok) throw new Error("Load more failed");
      const data = (await res.json()) as BridgeResolveResponse;
      const mapped: SongItem[] = (data.results || []).map((v) => ({
        id: v.id,
        source: v.source,
        streamRef: v.streamRef,
        videoId: v.videoId,
        title: v.title,
        artist: v.artist,
        subtitle: v.source === "spotify" ? "Spotify metadata -> YouTube bridge" : "YouTube bridge",
        thumbnail: v.thumbnail,
      }));
      setBridgeSongs((prev) => [...prev, ...mapped]);
      setSearchOffset(offset + mapped.length);
      setSearchHasMore(Boolean(data.hasMore) && mapped.length > 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Load more failed.";
      setError(msg);
      enqueueSnack(msg);
    } finally {
      setSearchLoadingMore(false);
    }
  };

  const playFromMain = async (song: SongItem) => {
    await playSongWithQueue(song, mainSongs);
  };

  const playFromPlaylist = async (song: SongItem) => {
    if (!selectedPlaylist) return;
    const runtimeSong = song as RuntimeSong;
    if (runtimeSong.unavailableReason) {
      setError(runtimeSong.unavailableReason);
      enqueueSnack(runtimeSong.unavailableReason);
      return;
    }
    await playSongWithQueue(song, selectedPlaylist.songs);
  };

  const createPlaylist = async () => {
    const name = newPlaylistName.trim();
    if (!name) return;

    const exists = playlists.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      enqueueSnack(`Playlist '${name}' already exists.`);
      return;
    }

    const res = await fetch(`${API_BASE}/playlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      setError("Failed to create playlist.");
      enqueueSnack("Failed to create playlist.");
      return;
    }

    setNewPlaylistName("");
    await loadPlaylists();
    enqueueSnack(`Playlist '${name}' created.`);
  };

  const renamePlaylist = async () => {
    if (!selectedPlaylistId || !selectedPlaylist) return;
    const name = renamePlaylistName.trim();
    if (!name) {
      enqueueSnack("Playlist name is required.");
      return;
    }

    const res = await fetch(`${API_BASE}/playlists/${encodeURIComponent(selectedPlaylistId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error || "Failed to rename playlist.";
      setError(msg);
      enqueueSnack(msg);
      return;
    }

    await loadPlaylists();
    enqueueSnack(`Playlist renamed to '${name}'.`);
  };

  const deletePlaylist = async () => {
    if (!selectedPlaylistId || !selectedPlaylist) return;
    const confirmed = window.confirm(`Delete playlist '${selectedPlaylist.name}'?`);
    if (!confirmed) return;

    const res = await fetch(`${API_BASE}/playlists/${encodeURIComponent(selectedPlaylistId)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error || "Failed to delete playlist.";
      setError(msg);
      enqueueSnack(msg);
      return;
    }

    await loadPlaylists();
    enqueueSnack(`Playlist '${selectedPlaylist.name}' deleted.`);
  };

  const addSongToPlaylist = async (song: SongItem, targetPlaylistId: string) => {
    const res = await fetch(`${API_BASE}/playlists/${encodeURIComponent(targetPlaylistId)}/songs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song: {
          id: song.id,
          source: song.source,
          title: song.title,
          artist: song.artist || "Unknown Artist",
          relativePath: song.relativePath,
          streamRef: song.streamRef,
          videoId: song.videoId,
          thumbnail: song.thumbnail,
          offlineFileName: song.offlineFileName,
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError("Failed to save song to playlist.");
      enqueueSnack("Failed to add song to playlist.");
      return;
    }

    await loadPlaylists();
    const selectedName = playlists.find((p) => p.id === targetPlaylistId)?.name || "playlist";
    enqueueSnack(data.added ? `Added '${song.title}' to ${selectedName}.` : `'${song.title}' already exists in ${selectedName}.`);
  };

  const removeSongFromPlaylist = async (song: SongItem) => {
    if (!selectedPlaylistId) return;
    const res = await fetch(
      `${API_BASE}/playlists/${encodeURIComponent(selectedPlaylistId)}/songs/${encodeURIComponent(song.id)}`,
      { method: "DELETE" }
    );
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error || "Failed to remove song from playlist.";
      setError(msg);
      enqueueSnack(msg);
      return;
    }
    await loadPlaylists();
    enqueueSnack(`Removed '${song.title}' from playlist.`);
  };

  const addToPlaylist = async (song: SongItem) => {
    if (playlists.length === 0) {
      setError("Create playlist first.");
      enqueueSnack("Create playlist first.");
      return;
    }

    let targetPlaylistId = selectedPlaylistId;
    if (!targetPlaylistId || !playlists.some((p) => p.id === targetPlaylistId)) {
      targetPlaylistId = playlists[0].id;
    }

    setAddSongTarget(song);
    setAddSongPlaylistId(targetPlaylistId);
  };

  const downloadSong = async (song: SongItem) => {
    const res = await fetch(`${API_BASE}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song: {
          id: song.id,
          source: song.source,
          title: song.title,
          artist: song.artist || "Unknown Artist",
          relativePath: song.relativePath,
          streamRef: song.streamRef,
          videoId: song.videoId,
          thumbnail: song.thumbnail,
          offlineFileName: song.offlineFileName,
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data?.error || "Download failed.");
      enqueueSnack(data?.error || "Download failed.");
      return;
    }

    if (data?.songUpdate?.id && data?.songUpdate?.offlineFileName) {
      updateSongEverywhere(data.songUpdate.id, { offlineFileName: data.songUpdate.offlineFileName });
    }

    enqueueSnack(`Downloaded '${song.title}' for offline usage.`);
  };

  const addToQueue = (song: SongItem) => {
    if (!isSongPlayable(song)) {
      const msg = `Song '${song.title}' is currently unavailable.`;
      setError(msg);
      enqueueSnack(msg);
      return;
    }
    setCurrentQueue((prev) => [...prev, song]);
    enqueueSnack(`Added '${song.title}' to queue.`);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch((err) => {
        if (isAbortLikePlaybackError(err)) return;
        const message = err instanceof Error && err.message ? err.message : "Unable to resume playback.";
        setError(message);
        enqueueSnack(message);
      });
    }
    else audio.pause();
  };

  const onSeek = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = audio.duration * ratio;
  };

  const onPrev = async () => {
    await playSongAtIndex(currentQueueIndex - 1);
  };

  const onNext = async () => {
    await playSongAtIndex(currentQueueIndex + 1);
  };

  const reorderQueue = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= currentQueue.length || toIndex >= currentQueue.length) return;

    const next = [...currentQueue];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setCurrentQueue(next);

    if (currentQueueIndex === fromIndex) {
      setCurrentQueueIndex(toIndex);
      return;
    }

    if (fromIndex < currentQueueIndex && toIndex >= currentQueueIndex) {
      setCurrentQueueIndex((prev) => prev - 1);
      return;
    }

    if (fromIndex > currentQueueIndex && toIndex <= currentQueueIndex) {
      setCurrentQueueIndex((prev) => prev + 1);
    }
  };

  const moveQueueItemBy = (index: number, delta: -1 | 1) => {
    const toIndex = index + delta;
    reorderQueue(index, toIndex);
  };

  useEffect(() => {
    void loadLocal();
    void loadPlaylists();
    hydrateQueueState();
  }, []);

  const resolvedIsDark =
    themePref === "dark" || (themePref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const themeIcon = resolvedIsDark ? "light_mode" : "dark_mode";
  const themeLabel = resolvedIsDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <div className={`app-shell ${!showRail ? "no-rail" : ""} ${!showQueuePanel ? "no-side" : ""}`}>
      {showRail && <aside className="mini-rail" aria-label="Sidebar">
        <div className="brand">YOUR WAVE</div>
        <md-icon-button class={`rail-button ${currentView === "library" ? "selected" : ""}`} aria-label="Library" onClick={() => setCurrentView("library")}>
          <span className="material-symbols-outlined">library_music</span>
        </md-icon-button>
        <md-icon-button class={`rail-button ${currentView === "playlists" ? "selected" : ""}`} aria-label="Playlists page" onClick={() => setCurrentView("playlists")}>
          <span className="material-symbols-outlined">queue_music</span>
        </md-icon-button>
        <md-icon-button
          class="rail-button"
          aria-label={themeLabel}
          onClick={() => setThemePref(resolvedIsDark ? "light" : "dark")}
        >
          <span className="material-symbols-outlined">{themeIcon}</span>
        </md-icon-button>
      </aside>}

      <main className="main-pane">
        {currentView === "library" ? (
          <>
            <div className="top-search">
              <md-outlined-text-field
                value={query}
                label="Search or paste Spotify URL"
                onInput={(e: Event) => setQuery((e.target as HTMLInputElement).value)}
              ></md-outlined-text-field>
              <md-icon-button onClick={() => void searchBridge()} aria-label="Search bridge">
                <span className="material-symbols-outlined">search</span>
              </md-icon-button>
              <md-icon-button onClick={() => void loadLocal()} aria-label="Rescan local music">
                <span className="material-symbols-outlined">sync</span>
              </md-icon-button>
              <md-icon-button onClick={() => setShowRail((v) => !v)} aria-label="Toggle left panel">
                <span className="material-symbols-outlined">{showRail ? "left_panel_close" : "left_panel_open"}</span>
              </md-icon-button>
              <md-icon-button onClick={() => setShowQueuePanel((v) => !v)} aria-label="Toggle right panel">
                <span className="material-symbols-outlined">{showQueuePanel ? "right_panel_close" : "right_panel_open"}</span>
              </md-icon-button>
            </div>

            <SongList
              songs={mainSongs}
              loading={loading}
              error={error}
              activeSongId={currentSong?.id || null}
              onPlaySong={(song) => void playFromMain(song)}
              onAddToQueue={addToQueue}
              onAddToPlaylist={(song) => void addToPlaylist(song)}
              onDownloadSong={(song) => void downloadSong(song)}
            />
            {searchHasMore && (
              <div className="load-more-wrap">
                <button className="modal-btn primary" onClick={() => void loadMoreBridge()} disabled={searchLoadingMore}>
                  {searchLoadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </>
        ) : (
          <section className="playlist-page" aria-label="Playlist page">
            <header className="playlist-page-header">
              <div>
                <h2>Playlists</h2>
                <p>Manage and play your saved collections.</p>
              </div>
              <div className="view-toggle">
                <md-icon-button
                  class={playlistDisplay === "grid" ? "selected" : ""}
                  aria-label="Grid view"
                  onClick={() => setPlaylistDisplay("grid")}
                >
                  <span className="material-symbols-outlined">grid_view</span>
                </md-icon-button>
                <md-icon-button
                  class={playlistDisplay === "list" ? "selected" : ""}
                  aria-label="List view"
                  onClick={() => setPlaylistDisplay("list")}
                >
                  <span className="material-symbols-outlined">view_list</span>
                </md-icon-button>
              </div>
            </header>

            <div className="playlist-create-row">
              <md-outlined-text-field
                value={newPlaylistName}
                label="New playlist"
                onInput={(e: Event) => setNewPlaylistName((e.target as HTMLInputElement).value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") void createPlaylist();
                }}
              ></md-outlined-text-field>
              <md-icon-button onClick={() => void createPlaylist()} aria-label="Create playlist">
                <span className="material-symbols-outlined">playlist_add_circle</span>
              </md-icon-button>
            </div>

            <div className="playlist-selector" aria-label="Playlist selector">
              {playlists.map((p) => (
                <button
                  key={p.id}
                  className={`playlist-chip ${selectedPlaylistId === p.id ? "active" : ""}`}
                  onClick={() => setSelectedPlaylistId(p.id)}
                >
                  {p.name} ({p.songs.length})
                </button>
              ))}
            </div>

            <div className="playlist-manage-row">
              <md-outlined-text-field
                value={renamePlaylistName}
                label="Rename selected playlist"
                onInput={(e: Event) => setRenamePlaylistName((e.target as HTMLInputElement).value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") void renamePlaylist();
                }}
              ></md-outlined-text-field>
              <md-icon-button onClick={() => void renamePlaylist()} aria-label="Rename playlist">
                <span className="material-symbols-outlined">drive_file_rename_outline</span>
              </md-icon-button>
              <md-icon-button onClick={() => void deletePlaylist()} aria-label="Delete playlist">
                <span className="material-symbols-outlined">delete</span>
              </md-icon-button>
            </div>

            <div className="playlist-page-title">
              <h3>{selectedPlaylist?.name || "No playlist selected"}</h3>
              <p>{selectedPlaylist ? `${selectedPlaylist.songs.length} songs` : "Create playlist to start."}</p>
            </div>

            {!selectedPlaylist || selectedPlaylist.songs.length === 0 ? (
              <div className="empty-state" aria-live="polite">
                <div className="watermark">BUILD YOUR SOUND BLOCK</div>
              </div>
            ) : playlistDisplay === "grid" ? (
              <div className="playlist-grid">
                {selectedPlaylist.songs.map((song) => (
                  <div key={song.id} className={`playlist-cover-card ${currentSong?.id === song.id ? "active" : ""}`}>
                    <button
                      className="playlist-remove-song"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeSongFromPlaylist(song);
                      }}
                      aria-label={`Remove ${song.title} from playlist`}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                    <button
                      className="playlist-cover-play"
                      onClick={() => void playFromPlaylist(song)}
                      aria-label={`Play ${song.title}`}
                    >
                    <img
                      src={song.thumbnail || "https://placehold.co/320x320/111111/b8b8b8?text=%E2%99%AB"}
                      alt=""
                    />
                    <div className="cover-meta">
                      <div className="cover-title">{song.title}</div>
                      <div className="cover-subtitle">{(song as RuntimeSong).unavailableReason ? "Unavailable" : song.artist || "Unknown artist"}</div>
                    </div>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <md-list className="playlist-list-view" aria-label="Playlist songs list">
                {selectedPlaylist.songs.map((song) => (
                  <div key={song.id} className={`playlist-list-item ${currentSong?.id === song.id ? "active" : ""}`}>
                    <button
                      className="playlist-list-play"
                      onClick={() => void playFromPlaylist(song)}
                      aria-label={`Play ${song.title}`}
                    >
                    <img
                      src={song.thumbnail || "https://placehold.co/90x90/111111/b8b8b8?text=%E2%99%AB"}
                      alt=""
                    />
                    <div>
                      <div className="song-title">{song.title}</div>
                      <div className="song-subtitle">{(song as RuntimeSong).unavailableReason ? "Unavailable" : song.artist || "Unknown artist"}</div>
                    </div>
                    </button>
                    <md-icon-button aria-label={`Remove ${song.title} from playlist`} onClick={() => void removeSongFromPlaylist(song)}>
                      <span className="material-symbols-outlined">delete</span>
                    </md-icon-button>
                  </div>
                ))}
              </md-list>
            )}
          </section>
        )}
      </main>

      {showQueuePanel && <aside className="playlist-panel" aria-label="Playback queue panel">
        <div className="panel-header queue-header">
          <h3>Queue</h3>
          <span>{currentQueue.length} tracks</span>
        </div>

        <div className="queue-list">
          {currentQueue.length === 0 ? (
            <div className="helper">Start playback to build queue.</div>
          ) : (
            currentQueue.map((song, index) => {
              const status = getQueueStatus(index, currentQueueIndex);
              const unavailable = unavailableSongIds[song.id];
              return (
                <div
                  key={`${song.id}-${index}`}
                  className={`queue-item ${status} ${index === currentQueueIndex ? "active" : ""}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", String(index))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = Number(e.dataTransfer.getData("text/plain"));
                    reorderQueue(from, index);
                  }}
                >
                  <div className="queue-nav">
                    <md-icon-button
                      aria-label={`Move ${song.title} up`}
                      disabled={index === 0}
                      onClick={(e: Event) => {
                        moveQueueItemBy(index, -1);
                      }}
                    >
                      <span className="material-symbols-outlined">keyboard_arrow_up</span>
                    </md-icon-button>
                    <md-icon-button
                      aria-label={`Move ${song.title} down`}
                      disabled={index === currentQueue.length - 1}
                      onClick={(e: Event) => {
                        moveQueueItemBy(index, 1);
                      }}
                    >
                      <span className="material-symbols-outlined">keyboard_arrow_down</span>
                    </md-icon-button>
                  </div>
                  <span className="queue-index">{index + 1}</span>
                  <button className="queue-main" onClick={() => void playSongAtIndex(index)} aria-label={`Play ${song.title}`}>
                    <img src={song.thumbnail || "https://placehold.co/48x48/111111/b8b8b8?text=%E2%99%AB"} alt="" />
                    <div>
                      <div className="queue-title">{song.title}</div>
                      <div className="queue-subtitle">{song.artist || "Unknown artist"}</div>
                    </div>
                  </button>
                  <span className={`queue-status ${status}`}>{unavailable ? "unavailable" : status === "now" ? "now playing" : status}</span>
                </div>
              );
            })
          )}
        </div>
      </aside>}

      <Player
        currentSong={currentSong}
        isPlaying={isPlaying}
        progress={progress}
        currentTime={currentTime}
        duration={duration}
        onTogglePlay={togglePlay}
        onSeek={onSeek}
        onPrev={() => void onPrev()}
        onNext={() => void onNext()}
        onOpenNowPlaying={() => setNowPlayingOpen(true)}
      />

      {nowPlayingOpen && (
        <div className="now-playing-overlay" role="dialog" aria-modal="true" aria-label="Now playing details">
          <div className="now-playing-card">
            <button className="now-playing-close" onClick={() => setNowPlayingOpen(false)} aria-label="Close now playing">
              <span className="material-symbols-outlined">close</span>
            </button>
            <img
              className="now-playing-cover"
              src={currentSong?.thumbnail || "https://placehold.co/480x480/111111/b8b8b8?text=%E2%99%AB"}
              alt=""
            />
            <div className="now-playing-title">{currentSong?.title || "No song selected"}</div>
            <div className="now-playing-artist">{currentSong?.artist || "Pick a track"}</div>
          </div>
        </div>
      )}

      {addSongTarget && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add song to playlist">
          <div className="modal-card">
            <h3>Add To Playlist</h3>
            <p className="modal-subtitle">{addSongTarget.title}</p>
            <div className="playlist-picker">
              {playlists.map((p) => (
                <button
                  key={p.id}
                  className={`playlist-picker-item ${addSongPlaylistId === p.id ? "active" : ""}`}
                  onClick={() => setAddSongPlaylistId(p.id)}
                >
                  {p.name} ({p.songs.length})
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="modal-btn" onClick={() => setAddSongTarget(null)}>Cancel</button>
              <button
                className="modal-btn primary"
                onClick={() => {
                  if (!addSongPlaylistId || !addSongTarget) return;
                  setSelectedPlaylistId(addSongPlaylistId);
                  void addSongToPlaylist(addSongTarget, addSongPlaylistId);
                  setAddSongTarget(null);
                }}
              >
                Add Song
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="live-region" aria-live="polite">
        {snackOpen ? snackText : ""}
      </div>
    </div>
  );
}
