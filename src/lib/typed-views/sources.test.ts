// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { sourceActionFor } from "./sources.js";

describe("sourceActionFor", () => {
  it("matches an open.spotify.com track to the Spotify action", () => {
    const m = sourceActionFor("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(m?.id).toBe("spotify");
    expect(m?.label).toBe("Open in Spotify");
    expect(m?.icon).toBe("external-link");
    expect(m?.brand).toBe("spotify");
    expect(m?.href).toBe("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  });

  it("matches playlists on the same host (host-keyed, not type-keyed)", () => {
    const m = sourceActionFor("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    expect(m?.id).toBe("spotify");
  });

  it("matches a *.spotify.com subdomain", () => {
    expect(sourceActionFor("https://play.spotify.com/track/x")?.id).toBe("spotify");
  });

  it("returns undefined for an unrecognised host (no raw-URL row)", () => {
    expect(sourceActionFor("https://example.com/track/x")).toBeUndefined();
    expect(sourceActionFor("https://notspotify.com/x")).toBeUndefined();
  });

  it("rejects non-http(s) schemes (safety: javascript:/data:/mailto:)", () => {
    expect(sourceActionFor("javascript:alert(1)")).toBeUndefined();
    expect(sourceActionFor("data:text/html,<script>")).toBeUndefined();
    expect(sourceActionFor("mailto:a@b.com")).toBeUndefined();
  });

  it("returns undefined for absent or unparsable input", () => {
    expect(sourceActionFor(undefined)).toBeUndefined();
    expect(sourceActionFor("")).toBeUndefined();
    expect(sourceActionFor("not a url")).toBeUndefined();
  });

  it("is case-insensitive on the host", () => {
    expect(sourceActionFor("https://OPEN.SPOTIFY.COM/track/x")?.id).toBe("spotify");
  });
});
