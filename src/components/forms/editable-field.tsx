// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `EditableField` — the generic, controlled editor for one {@link FieldSpec}.
 * Renders the right widget for the field's `kind` (text / textarea / url /
 * email / tel / date / datetime / number / decimal / boolean / choice) and is
 * fully controlled: the parent owns the value and dirty/saving/error state. This
 * is the single building block both the inline typed-view editor and the
 * `FormRenderer` compose, so editing looks identical everywhere.
 *
 * Pure presentation: it does no I/O and holds no save state itself — it reports
 * changes up via `onChange`. Save orchestration (conditional PUT, 412/403) lives
 * in the parent + the `forms/write.ts` engine.
 */
import { useId } from "react";
import type { FieldSpec } from "@/lib/forms/field-types";
import { controlFor, toControlValue } from "@/lib/forms/field-input";
import { sourceFor } from "@/lib/forms/autocomplete";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export interface EditableFieldProps {
  field: FieldSpec;
  /** The current (display) value. */
  value: string;
  onChange: (value: string) => void;
  /** A per-field validation/save error message to surface. */
  error?: string;
  /** Disable the control (e.g. while a save is in flight). */
  disabled?: boolean;
}

export function EditableField({ field, value, onChange, error, disabled }: EditableFieldProps) {
  const id = useId();
  const { control, inputType } = controlFor(field.kind);
  const describedBy = error ? `${id}-error` : field.hint ? `${id}-hint` : undefined;
  const autoSource = sourceFor(field.autocomplete);

  return (
    <div className="flex flex-col gap-1.5">
      {control === "checkbox" ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === "true"}
            disabled={disabled || field.readOnly}
            onCheckedChange={(c) => onChange(c === true ? "true" : "false")}
            aria-describedby={describedBy}
          />
          <Label htmlFor={id}>
            {field.label}
            {field.required && <RequiredMark />}
          </Label>
        </div>
      ) : (
        <>
          <Label htmlFor={id}>
            {field.label}
            {field.required && <RequiredMark />}
          </Label>

          {control === "textarea" && (
            <Textarea
              id={id}
              value={value}
              disabled={disabled || field.readOnly}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => onChange(e.target.value)}
            />
          )}

          {control === "select" && (
            <select
              id={id}
              value={value}
              disabled={disabled || field.readOnly}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => onChange(e.target.value)}
              className={cn(
                "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive",
              )}
            >
              <option value="">—</option>
              {field.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}

          {control === "input" && (
            <>
              <Input
                id={id}
                type={inputType}
                value={toControlValue(field.kind, value)}
                disabled={disabled || field.readOnly}
                list={autoSource ? `${id}-list` : undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                onChange={(e) => onChange(e.target.value)}
              />
              {autoSource && (
                <datalist id={`${id}-list`}>
                  {/* Sync suggestions only (the shipped sources are static/offline). */}
                  {asArray(autoSource.suggest(value, 8)).map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </datalist>
              )}
            </>
          )}
        </>
      )}

      {field.hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {field.hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function RequiredMark() {
  return (
    <span className="ml-0.5 text-destructive" aria-hidden="true">
      *
    </span>
  );
}

/** Narrow a sync-or-async suggestion result to the sync array (datalist is sync). */
function asArray<T>(value: T[] | Promise<T[]>): T[] {
  return Array.isArray(value) ? value : [];
}
