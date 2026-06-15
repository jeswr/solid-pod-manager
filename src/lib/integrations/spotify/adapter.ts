/**
 * Spotify → Media. Top tracks (`/me/top/tracks`) and playlists
 * (`/me/playlists`) as `schema:MusicRecording` / `schema:MusicPlaylist`.
 * Spotify supports secretless PKCE for public clients, so live mode needs
 * only a client id. Snapshot semantics (the API has no change cursor).
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import { arr, optionalNumber, optionalText, SkipCounter } from "../core/safe.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, MusicPlaylist, MusicRecording } from "../core/vocab.js";
import {
  type SpotifyPlaylists,
  SPOTIFY_FIXTURES,
  type SpotifyTopTracks,
} from "./fixtures.js";

const ID = "spotify";
const API = "https://api.spotify.com/v1";
const SCOPES = ["user-top-read", "playlist-read-private"] as const;

export const spotifyAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Spotify",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media"],
    whatYouGet: "Your top tracks and your playlists, saved as music records in Media.",
    requirements: [
      "Create an app at developer.spotify.com/dashboard (no review needed for personal use).",
      "Add <app-origin>/oauth-callback.html as a Redirect URI.",
      "Set NEXT_PUBLIC_SPOTIFY_CLIENT_ID — Spotify supports secretless PKCE, no proxy needed.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID,
    authorizationEndpoint: "https://accounts.spotify.com/authorize",
    tokenEndpoint: "https://accounts.spotify.com/api/token",
    scopes: SCOPES,
    tokenExchange: "public",
  },
  fixtures: () => SPOTIFY_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    const skipped = new SkipCounter();

    ctx.progress({ label: "Fetching your top tracks…", done: 0, total: 2 });
    const top = await getJson<SpotifyTopTracks>(ID, ctx.api, `${API}/me/top/tracks?limit=50`);

    const tracksDoc = ctx.resolve("music/top-tracks.ttl");
    const tracks = new Store();
    for (const t of arr(top?.items)) {
      // A track with no id has no stable fragment IRI — skip it.
      if (!t || optionalText(t.id) === undefined) {
        skipped.skip();
        continue;
      }
      const rec = new MusicRecording(`${tracksDoc}#track-${t.id}`, tracks, DataFactory).mark();
      rec.name = optionalText(t.name);
      rec.identifier = t.id;
      const artists = arr(t.artists)
        .map((a) => optionalText(a?.name))
        .filter((n): n is string => n !== undefined);
      rec.byArtist = artists.length > 0 ? artists.join(", ") : undefined;
      rec.inAlbum = optionalText(t.album?.name);
      // FOLLOW-UP (typed-views P2 / docs §6 Q4): no album-art triple is imported
      // today — only `album.name`. Adding e.g.
      //   rec.image = optionalText(t.album?.images?.[0]?.url)
      // (a `schema:image` setter on MusicRecording + `images` on SpotifyTrack)
      // would populate real cover art; the music card already renders it `if
      // present` and shows a music-note icon fallback otherwise. Left as a
      // separate, reviewed change — not made here.
      const ms = optionalNumber(t.duration_ms);
      rec.duration = ms !== undefined ? isoDuration(ms) : undefined;
      rec.sourceUrl = optionalText(t.external_urls?.spotify);
    }
    await ctx.write({
      slug: "music/top-tracks.ttl",
      category: "media",
      forClass: CLASSES.MusicRecording,
      dataset: tracks,
    });

    ctx.progress({ label: "Fetching your playlists…", done: 1, total: 2 });
    const lists = await getJson<SpotifyPlaylists>(ID, ctx.api, `${API}/me/playlists?limit=50`);

    const listsDoc = ctx.resolve("music/playlists.ttl");
    const playlists = new Store();
    for (const p of arr(lists?.items)) {
      // Spotify can return null entries in the playlists array (collaborative
      // playlists you've lost access to) — skip them. No id ⇒ no fragment IRI.
      if (!p || optionalText(p.id) === undefined) {
        skipped.skip();
        continue;
      }
      const pl = new MusicPlaylist(`${listsDoc}#playlist-${p.id}`, playlists, DataFactory).mark();
      pl.name = optionalText(p.name);
      pl.identifier = p.id;
      pl.description = optionalText(p.description);
      // The live bug: `tracks` is absent on some playlist items. Default to 0.
      pl.numTracks = optionalNumber(p.tracks?.total) ?? 0;
      pl.sourceUrl = optionalText(p.external_urls?.spotify);
    }
    await ctx.write({
      slug: "music/playlists.ttl",
      category: "media",
      forClass: CLASSES.MusicPlaylist,
      dataset: playlists,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return { skipped: skipped.value };
  },
};

/** 213573 ms → `PT3M33S` (schema:duration is ISO 8601). */
function isoDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `PT${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${s}S`;
}
