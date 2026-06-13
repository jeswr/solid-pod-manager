// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Server shell for the files item view. The resource is addressed by the
 * `?url=` query parameter and loaded entirely client-side (FileItemView), so
 * this route prerenders as one static page under `output: export`.
 */
import { FileItemView } from "./item-view";

export default function FileItemPage() {
  return <FileItemView />;
}
