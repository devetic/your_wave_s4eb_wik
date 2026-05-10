import { useMemo, useRef } from "react";
import "@material/web/iconbutton/filled-icon-button.js";
import "@material/web/progress/linear-progress.js";
import type { SongItem } from "./SongList";

type PlayerProps = {
  currentSong: SongItem | null;
  isPlaying: boolean;
  progress: number;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (ratio: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenNowPlaying: () => void;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function Player({
  currentSong,
  isPlaying,
  progress,
  currentTime,
  duration,
  onTogglePlay,
  onSeek,
  onPrev,
  onNext,
  onOpenNowPlaying,
}: PlayerProps) {
  const seekRef = useRef<HTMLDivElement | null>(null);

  const safeProgress = useMemo(() => {
    if (!Number.isFinite(progress)) return 0;
    return Math.max(0, Math.min(1, progress));
  }, [progress]);

  const handleSeek = (clientX: number) => {
    if (!seekRef.current) return;
    const rect = seekRef.current.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, ratio)));
  };

  return (
    <footer className="player-bar" aria-label="Now playing">
      <div className="player-meta">
        <button className="player-cover-button" onClick={onOpenNowPlaying} aria-label="Open now playing">
          <img
            src={currentSong?.thumbnail || "https://placehold.co/56x56/1f1f1f/e5e2eb?text=?"}
            alt=""
          />
        </button>
        <div>
          <div className="player-title">{currentSong?.title || "No song selected"}</div>
          <div className="player-artist">{currentSong?.artist || "Pick a track"}</div>
        </div>
      </div>

      <div className="player-center">
        <div className="controls">
          <md-filled-icon-button onClick={onPrev} aria-label="Previous song">
            <span className="material-symbols-outlined">skip_previous</span>
          </md-filled-icon-button>
          <md-filled-icon-button onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
            <span className="material-symbols-outlined">{isPlaying ? "pause" : "play_arrow"}</span>
          </md-filled-icon-button>
          <md-filled-icon-button onClick={onNext} aria-label="Next song">
            <span className="material-symbols-outlined">skip_next</span>
          </md-filled-icon-button>
        </div>

        <div className="seek-wrap">
          <span className="seek-time">{formatTime(currentTime)}</span>
          <div className="seek-interactive" ref={seekRef} onClick={(e) => handleSeek(e.clientX)}>
            <md-linear-progress value={safeProgress}></md-linear-progress>
          </div>
          <span className="seek-time">{formatTime(duration)}</span>
        </div>
      </div>
    </footer>
  );
}
