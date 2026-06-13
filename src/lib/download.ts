// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tiny browser helpers shared by the import/export affordances: trigger a
 * client-side text download, and read a picked file as text. Kept here (not in a
 * component) so the apps that export iCal / vCard share one implementation and
 * the SSR/`output: "export"` build never touches `document` at module load.
 */

/** Download `content` as a file named `filename` with the given MIME `type`. */
export function downloadText(filename: string, content: string, type: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click has dispatched.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Read a picked `File` as a UTF-8 string. */
export function readFileText(file: File): Promise<string> {
  return file.text();
}
