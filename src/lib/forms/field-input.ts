// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Pure widget mapping for the form renderer: which native control + HTML input
 * `type` a {@link FieldKind} should use, and the value-format helpers the editor
 * needs (an `xsd:dateTime` literal ↔ a browser `datetime-local` value). Kept
 * pure + node-testable so the React layer stays a thin shell.
 */
import type { FieldKind } from "./field-types.js";

/** Which control the renderer should mount. */
export type Control = "input" | "textarea" | "checkbox" | "select";

/** The native control + (for inputs) HTML `type` for a field kind. */
export function controlFor(kind: FieldKind): { control: Control; inputType?: string } {
  switch (kind) {
    case "textarea":
      return { control: "textarea" };
    case "boolean":
      return { control: "checkbox" };
    case "choice":
      return { control: "select" };
    case "url":
      return { control: "input", inputType: "url" };
    case "email":
      return { control: "input", inputType: "email" };
    case "tel":
      return { control: "input", inputType: "tel" };
    case "date":
      return { control: "input", inputType: "date" };
    case "datetime":
      return { control: "input", inputType: "datetime-local" };
    case "number":
      return { control: "input", inputType: "number" };
    case "decimal":
      return { control: "input", inputType: "number" };
    default:
      return { control: "input", inputType: "text" };
  }
}

/**
 * Turn a stored value into the string the control expects to display.
 * For `datetime`, an ISO-8601 literal becomes the `yyyy-MM-ddThh:mm` the
 * `datetime-local` input requires (local time, seconds dropped). Everything else
 * passes through.
 */
export function toControlValue(kind: FieldKind, stored: string): string {
  if (kind !== "datetime" || stored === "") return stored;
  const t = Date.parse(stored);
  if (Number.isNaN(t)) return stored;
  const d = new Date(t);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
