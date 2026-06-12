/**
 * Recorded Spotify Web API shapes (api.spotify.com/v1) — trimmed to the
 * fields the adapter reads. Sources: GET /me/top/tracks, GET /me/playlists.
 */
import type { FixtureRoute } from "../core/types.js";

// Field optionality reflects what the *live* API can actually return (sparser
// than the docs imply), not just the tidy recorded fixtures: nested objects can
// be absent and arrays can carry null entries.
export interface SpotifyTrack {
  id: string;
  name?: string | null;
  duration_ms?: number | null;
  artists?: ({ name?: string | null } | null)[] | null;
  album?: { name?: string | null } | null;
  external_urls?: { spotify?: string | null } | null;
}

export interface SpotifyTopTracks {
  items?: (SpotifyTrack | null)[] | null;
}

export interface SpotifyPlaylist {
  id: string;
  name?: string | null;
  description?: string | null;
  /** Absent on some live playlist items — the source of the live `.total` crash. */
  tracks?: { total?: number | null } | null;
  external_urls?: { spotify?: string | null } | null;
}

export interface SpotifyPlaylists {
  items?: (SpotifyPlaylist | null)[] | null;
}

export const TOP_TRACKS: SpotifyTopTracks = {
  items: [
    {
      id: "4uLU6hMCjMI75M1A2tKUQC",
      name: "Never Gonna Give You Up",
      duration_ms: 213573,
      artists: [{ name: "Rick Astley" }],
      album: { name: "Whenever You Need Somebody" },
      external_urls: { spotify: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" },
    },
    {
      id: "0VjIjW4GlUZAMYd2vXMi3b",
      name: "Blinding Lights",
      duration_ms: 200040,
      artists: [{ name: "The Weeknd" }],
      album: { name: "After Hours" },
      external_urls: { spotify: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b" },
    },
    {
      id: "05wIrZSwuaVWhcv5FfqeH0",
      name: "Walking on a Dream",
      duration_ms: 198440,
      artists: [{ name: "Empire of the Sun" }],
      album: { name: "Walking on a Dream" },
      external_urls: { spotify: "https://open.spotify.com/track/05wIrZSwuaVWhcv5FfqeH0" },
    },
  ],
};

export const PLAYLISTS: SpotifyPlaylists = {
  items: [
    {
      id: "37i9dQZF1DXcBWIGoYBM5M",
      name: "Focus Flow",
      description: "Instrumentals to keep you in the zone.",
      tracks: { total: 74 },
      external_urls: { spotify: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" },
    },
    {
      id: "5ABHKGoOzxkaa28ttQV9sE",
      name: "Sunday Morning",
      description: "Slow starts and coffee.",
      tracks: { total: 41 },
      external_urls: { spotify: "https://open.spotify.com/playlist/5ABHKGoOzxkaa28ttQV9sE" },
    },
  ],
};

export const SPOTIFY_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.spotify.com/v1/me/top/tracks", json: TOP_TRACKS },
  { url: "https://api.spotify.com/v1/me/playlists", json: PLAYLISTS },
];
