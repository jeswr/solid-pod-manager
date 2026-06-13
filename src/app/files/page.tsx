// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Server shell for the files browser. The container is addressed entirely by
 * the `?url=` query parameter and loaded client-side (FilesBrowser), so this
 * route prerenders as one static page under `output: export`.
 */
import { FilesBrowser } from "./files-browser";

export default function FilesPage() {
  return <FilesBrowser />;
}
