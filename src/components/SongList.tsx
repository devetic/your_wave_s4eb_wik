import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/iconbutton/icon-button.js";

export type SongItem = {
  id: string;
  source: "local" | "youtube" | "spotify";
  title: string;
  artist?: string | null;
  subtitle?: string;
  thumbnail?: string | null;
  relativePath?: string;
  videoId?: string;
  streamRef?: string;
  offlineFileName?: string;
};

type SongListProps = {
  songs: SongItem[];
  loading?: boolean;
  error?: string | null;
  activeSongId?: string | null;
  onPlaySong: (song: SongItem) => void;
  onAddToQueue: (song: SongItem) => void;
  onAddToPlaylist: (song: SongItem) => void;
  onDownloadSong: (song: SongItem) => void;
};

export function SongList({
  songs,
  loading = false,
  error = null,
  activeSongId = null,
  onPlaySong,
  onAddToQueue,
  onAddToPlaylist,
  onDownloadSong,
}: SongListProps) {
  if (loading) return <div className="helper">Loading songs...</div>;
  if (error) return <div className="helper">{error}</div>;

  if (songs.length === 0) {
    return (
      <div className="empty-state" aria-live="polite">
        <div className="watermark">THROUGH SILENCE, FIND FOCUS</div>
      </div>
    );
  }

  return (
    <md-list className="song-list" aria-label="Songs">
      {songs.map((song) => (
        <div key={song.id} className={`song-row ${activeSongId === song.id ? "active" : ""}`}>
          <button className="song-main" onClick={() => onPlaySong(song)} aria-label={`Play ${song.title}`}>
            <img
              className="song-thumb"
              src={song.thumbnail || "https://placehold.co/64x64/1f1f1f/e5e2eb?text=?"}
              alt=""
            />
            <div>
              <div className="song-title">{song.title}</div>
              <div className="song-subtitle">{song.artist || song.subtitle || "Unknown artist"}</div>
              <div className="song-badge">{song.offlineFileName ? "Offline Ready" : song.source}</div>
            </div>
          </button>
          <div className="song-actions">
            <md-icon-button aria-label="Add song to queue" onClick={() => onAddToQueue(song)}>
              <span className="material-symbols-outlined">queue_music</span>
            </md-icon-button>
            <md-icon-button aria-label="Add song to playlist" onClick={() => onAddToPlaylist(song)}>
              <span className="material-symbols-outlined">playlist_add</span>
            </md-icon-button>
            <md-icon-button aria-label="Download song for offline" onClick={() => onDownloadSong(song)}>
              <span className="material-symbols-outlined">download</span>
            </md-icon-button>
          </div>
        </div>
      ))}
    </md-list>
  );
}
