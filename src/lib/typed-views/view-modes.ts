// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * View-switcher logic (SolidOS-parity A3 — the pane icon tray).
 *
 * SolidOS's most-loved navigation affordance is the per-resource icon tray that
 * toggles between renderings (Folder / About / Source / Data / N3 / Sharing).
 * We offer a smaller, principled subset for an RDF resource:
 *
 *   - `typed`  — the domain card (Contacts/Music/Events/…), the **default**;
 *   - `data`   — the generic raw-triples table (the existing `RdfViewer`);
 *   - `source` — the resource on its source platform, only when a typed card
 *                resolved a `sourceActionFor` link (the branded "Open in …").
 *
 * Critically this preserves the **no-raw-RDF-by-default** thesis (§5.1): `typed`
 * is always the initial mode when a typed view exists; raw triples are reachable
 * but never the landing view. When no typed view matches, the table *is* the
 * default (there is nothing more legible to fall back from), so the tray offers
 * nothing to switch and is suppressed.
 *
 * Pure + DOM-free (node-testable): it decides *which* modes a resource offers and
 * what the initial mode is. The icon tray component in
 * `src/components/typed-views/view-switcher.tsx` renders the result.
 */

/** The rendering a resource can be shown in. */
export type ViewMode = "typed" | "data" | "table" | "source";

/** Inputs that decide the available modes (all derivable without I/O). */
export interface ViewModeInputs {
  /** Does a typed viewer match this resource? */
  hasTypedView: boolean;
  /** Is there an outbound source action (an "Open in …" link)? */
  hasSource: boolean;
  /**
   * Does the resource hold a tabulatable class — an `rdf:type` with two or more
   * instances (A5)? When true, a "Table" mode lists every instance as a row.
   */
  hasClassTable?: boolean;
}

/** A user-facing mode option with stable id + label + lucide icon name. */
export interface ViewModeOption {
  mode: ViewMode;
  label: string;
  /** Lucide icon name, resolved to a component in the UI layer only. */
  icon: string;
}

/** Static option metadata, keyed by mode (labels/icons live with the logic). */
const OPTION_META: Record<ViewMode, Omit<ViewModeOption, "mode">> = {
  typed: { label: "Card", icon: "layout-grid" },
  data: { label: "Data", icon: "table" },
  table: { label: "Table", icon: "table-rows" },
  source: { label: "Source", icon: "external-link" },
};

/**
 * The ordered list of modes a resource offers, most-legible first (so the tray
 * reads left-to-right from friendliest to rawest). Always includes the raw
 * `data` table when there is *something else* to switch to — a lone `data`
 * rendering needs no tray, so an untyped resource with no class table yields an
 * empty list (the table is then the default and the tray is hidden).
 */
export function availableViewModes(inputs: ViewModeInputs): ViewMode[] {
  const modes: ViewMode[] = [];
  if (inputs.hasTypedView) modes.push("typed");
  modes.push("data");
  if (inputs.hasClassTable) modes.push("table");
  if (inputs.hasSource) modes.push("source");
  // Nothing to switch between (only the raw `data` table) → no tray.
  return modes.length > 1 ? modes : [];
}

/** Resolve modes to full options (label + icon), preserving order. */
export function viewModeOptions(inputs: ViewModeInputs): ViewModeOption[] {
  return availableViewModes(inputs).map((mode) => ({ mode, ...OPTION_META[mode] }));
}

/**
 * The initial mode: always `typed` when a typed view exists (no-raw-RDF default,
 * §5.1); otherwise `data` (the generic table is the only rendering). Never
 * `source` initially — that is a deliberate user action, not a landing view.
 */
export function initialViewMode(inputs: ViewModeInputs): ViewMode {
  return inputs.hasTypedView ? "typed" : "data";
}

/**
 * Should the switcher tray be shown at all? Only when there is more than one
 * mode to choose between — a lone rendering needs no toggle.
 */
export function shouldShowSwitcher(inputs: ViewModeInputs): boolean {
  return availableViewModes(inputs).length > 1;
}
