// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `useFormEdit` — the editing state machine shared by the inline typed-view
 * editor and the `FormRenderer`. It seeds field values from the read dataset,
 * tracks dirty/saving/error state, and saves the whole subject back through the
 * conditional-write engine (`forms/write.ts`), threading the ETag so concurrent
 * edits surface as a clear "changed elsewhere" instead of clobbering.
 *
 * On a successful save it refreshes its dataset + ETag from the re-read so a
 * second edit chains cleanly. On `stale` it asks the caller to reload (via
 * `onReload`); on `forbidden`/`validation`/`error` it surfaces the message.
 */
import { useCallback, useMemo, useState } from "react";
import type { DatasetCore } from "@rdfjs/types";
import type { FieldSpec } from "@/lib/forms/field-types";
import { readFieldValue } from "@/lib/forms/subject-edit";
import { saveFormEdits, type SaveResult } from "@/lib/forms/write";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseFormEditArgs {
  url: string;
  /** The parsed dataset that was read (source of truth for unrelated triples). */
  dataset: DatasetCore;
  subject: string;
  fields: readonly FieldSpec[];
  /** ETag from the read, for `If-Match`. */
  etag: string | null;
  /** Called when a save reports `stale` — the caller should re-fetch. */
  onReload?: () => void;
  /** Test-only fetch override; **omit in production**. */
  fetchImpl?: typeof fetch;
}

export interface FormEditState {
  values: Record<string, string>;
  setValue: (id: string, value: string) => void;
  dirty: boolean;
  status: SaveStatus;
  /** A general (non-field) error message. */
  error?: string;
  /** Per-field validation errors, keyed by field id. */
  fieldErrors: Record<string, string>;
  save: () => Promise<void>;
  reset: () => void;
}

/** Seed the editable values from the dataset. */
function seedValues(
  dataset: DatasetCore,
  subject: string,
  fields: readonly FieldSpec[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.id] = readFieldValue(dataset, subject, f);
  return out;
}

export function useFormEdit(args: UseFormEditArgs): FormEditState {
  const { url, subject, fields, fetchImpl, onReload } = args;
  const [dataset, setDataset] = useState(args.dataset);
  const [etag, setEtag] = useState(args.etag);

  const initial = useMemo(() => seedValues(dataset, subject, fields), [dataset, subject, fields]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const dirty = useMemo(
    () => fields.some((f) => (values[f.id] ?? "") !== (initial[f.id] ?? "")),
    [fields, values, initial],
  );

  const setValue = useCallback((id: string, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    setFieldErrors((prev) => (prev[id] ? { ...prev, [id]: "" } : prev));
    setStatus("idle");
    setError(undefined);
  }, []);

  const reset = useCallback(() => {
    setValues(initial);
    setFieldErrors({});
    setError(undefined);
    setStatus("idle");
  }, [initial]);

  const save = useCallback(async () => {
    setStatus("saving");
    setError(undefined);
    setFieldErrors({});
    // Only send the dirty fields (others are left exactly as read).
    const changed: Record<string, string> = {};
    for (const f of fields) {
      if ((values[f.id] ?? "") !== (initial[f.id] ?? "")) changed[f.id] = values[f.id] ?? "";
    }
    const result: SaveResult = await saveFormEdits(url, dataset, subject, fields, changed, {
      etag,
      fetchImpl,
    });

    if (result.ok) {
      setEtag(result.etag);
      // Apply the edits to our local dataset so dirty-state resets cleanly and a
      // subsequent edit chains off the new baseline without a refetch.
      const { applyFieldEdits } = await import("@/lib/forms/subject-edit");
      setDataset(applyFieldEdits(dataset, subject, fields, changed));
      setStatus("saved");
      return;
    }

    setStatus("error");
    if (result.reason === "validation" && result.fieldId) {
      setFieldErrors({ [result.fieldId]: result.message });
    } else if (result.reason === "stale") {
      setError(result.message);
      onReload?.();
    } else {
      setError(result.message);
    }
  }, [url, dataset, subject, fields, values, initial, etag, fetchImpl, onReload]);

  return { values, setValue, dirty, status, error, fieldErrors, save, reset };
}
