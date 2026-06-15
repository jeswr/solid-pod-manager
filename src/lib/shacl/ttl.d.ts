// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// Vendored SHACL shapes are imported as raw Turtle text. Both bundlers are
// configured to treat `.ttl` as source text — webpack via an `asset/source`
// rule (next.config.ts), Vitest/Vite via a raw transform (vitest.config.ts).
declare module "*.ttl" {
  const content: string;
  export default content;
}
