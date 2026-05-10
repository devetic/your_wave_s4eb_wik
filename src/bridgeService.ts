import ytSearch from "yt-search";
import SpotifyWebApi from "spotify-web-api-node";
import youtubedl from "youtube-dl-exec";

export type BridgeResolvedTrack = {
  id: string;
  source: "youtube" | "spotify";
  input: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  videoId: string;
  streamRef: string;
};

type SpotifyMeta = {
  title: string;
  artist: string;
};

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

function isSpotifyUrl(input: string): boolean {
  return /open\.spotify\.com\/(track|album|playlist)\//i.test(input);
}

function extractSpotifyTrackId(input: string): string | null {
  const match = input.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/i);
  return match?.[1] ?? null;
}

async function resolveSpotifyMetadata(spotifyUrl: string): Promise<SpotifyMeta> {
  const trackId = extractSpotifyTrackId(spotifyUrl);

  // Placeholder behavior: if credentials and a track ID exist, try live lookup.
  // Otherwise return generic metadata so bridge flow still works.
  if (!trackId || !process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return {
      title: "Spotify Track",
      artist: "Unknown Artist",
    };
  }

  try {
    const token = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(token.body["access_token"]);
    const track = await spotifyApi.getTrack(trackId);

    return {
      title: track.body.name || "Spotify Track",
      artist: track.body.artists?.map((a: { name: string }) => a.name).join(", ") || "Unknown Artist",
    };
  } catch {
    return {
      title: "Spotify Track",
      artist: "Unknown Artist",
    };
  }
}

function makeStreamRef(payload: { source: "youtube" | "spotify"; input: string; videoId: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parseStreamRef(streamRef: string): { source: "youtube" | "spotify"; input: string; videoId: string } {
  const decoded = Buffer.from(streamRef, "base64url").toString("utf8");
  return JSON.parse(decoded) as { source: "youtube" | "spotify"; input: string; videoId: string };
}

export async function resolveBridgeInput(
  input: string,
  opts?: { limit?: number; offset?: number }
): Promise<BridgeResolvedTrack[]> {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  if (isSpotifyUrl(trimmed)) {
    const meta = await resolveSpotifyMetadata(trimmed);
    const ytQuery = `${meta.artist} - ${meta.title}`;
    const ytResult = await ytSearch(ytQuery);
    const video = ytResult.videos[0];

    if (!video?.videoId) {
      return [];
    }

    return [
      {
        id: `spotify:${video.videoId}`,
        source: "spotify",
        input: trimmed,
        title: meta.title,
        artist: meta.artist,
        thumbnail: video.thumbnail ?? null,
        videoId: video.videoId,
        streamRef: makeStreamRef({ source: "spotify", input: trimmed, videoId: video.videoId }),
      },
    ];
  }

  const ytResult = await ytSearch(trimmed);
  const limit = Math.max(1, Math.min(Number(opts?.limit ?? 50), 200));
  const offset = Math.max(0, Number(opts?.offset ?? 0));
  return ytResult.videos.slice(offset, offset + limit).map((video) => ({
    id: `youtube:${video.videoId}`,
    source: "youtube",
    input: trimmed,
    title: video.title,
    artist: video.author?.name ?? "Unknown Artist",
    thumbnail: video.thumbnail ?? null,
    videoId: video.videoId,
    streamRef: makeStreamRef({ source: "youtube", input: trimmed, videoId: video.videoId }),
  }));
}

export async function getDirectAudioUrlFromVideoId(videoId: string): Promise<string> {
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // yt-dlp wrapper: resolve direct playable audio URL.
  const output = await (youtubedl as any)(youtubeUrl, {
    getUrl: true,
    format: "bestaudio/best",
    noWarnings: true,
    noCheckCertificates: true,
  });

  if (Array.isArray(output)) {
    if (!output[0]) throw new Error("No audio URL returned by yt-dlp");
    return String(output[0]).trim();
  }

  const resolved = String(output).trim();
  if (!resolved) {
    throw new Error("No audio URL returned by yt-dlp");
  }

  return resolved;
}
