// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `FormRenderer` — renders an ordered {@link FieldSpec} list bound to a subject
 * as an editable form, with Save / Reset and loading/dirty/saved/error states.
 * It is source-agnostic: the fields may have come from a Solid `ui:` form, a
 * first-party typed-view edit map, or an auto-generated form (`resolveForm`).
 * The save path is the shared conditional-write engine, so a concurrent edit
 * surfaces as "changed elsewhere" rather than clobbering.
 */
import { Loader2, RotateCcw, Save } from "lucide-react";
import type { DatasetCore } from "@rdfjs/types";
import type { FieldSpec } from "@/lib/forms/field-types";
import type { FormSource } from "@/lib/forms/resolve-form";
import { useFormEdit } from "@/components/forms/use-form-edit";
import { EditableField } from "@/components/forms/editable-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface FormRendererProps {
  url: string;
  dataset: DatasetCore;
  subject: string;
  fields: readonly FieldSpec[];
  etag: string | null;
  /** Where the fields came from — drives a small provenance hint. */
  source?: FormSource;
  /** Re-fetch the resource (called when a save reports a stale ETag). */
  onReload?: () => void;
  /** Test-only fetch override; **omit in production**. */
  fetchImpl?: typeof fetch;
}

const SOURCE_HINT: Record<FormSource, string> = {
  "ui-form": "Editing with this resource's form description.",
  "typed-view": "Editing the recognised fields for this item.",
  auto: "Auto-generated editor from this item's data.",
};

export function FormRenderer({
  url,
  dataset,
  subject,
  fields,
  etag,
  source,
  onReload,
  fetchImpl,
}: FormRendererProps) {
  const edit = useFormEdit({ url, dataset, subject, fields, etag, onReload, fetchImpl });

  if (fields.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There are no editable fields for this resource.
      </p>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-5">
        {source && <p className="text-xs text-muted-foreground">{SOURCE_HINT[source]}</p>}

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void edit.save();
          }}
        >
          {fields.map((field) => (
            <EditableField
              key={field.id}
              field={field}
              value={edit.values[field.id] ?? ""}
              error={edit.fieldErrors[field.id]}
              disabled={edit.status === "saving"}
              onChange={(v) => edit.setValue(field.id, v)}
            />
          ))}

          {edit.error && (
            <p role="alert" className="text-sm text-destructive">
              {edit.error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!edit.dirty || edit.status === "saving"}>
              {edit.status === "saving" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!edit.dirty || edit.status === "saving"}
              onClick={edit.reset}
            >
              <RotateCcw aria-hidden="true" />
              Reset
            </Button>
            {edit.status === "saved" && !edit.dirty && (
              <span className="text-sm text-muted-foreground" role="status">
                Saved
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
