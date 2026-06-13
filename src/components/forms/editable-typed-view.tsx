// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `EditableTypedView` — turns a #61 read-only typed card editable in place
 * (Wave 5 §1). It enumerates the resource's editable subjects (the same subjects
 * the matching extractor renders) and, for each, renders a {@link FormRenderer}
 * bound to that subject with the per-view field→predicate edit map. Each field
 * writes back to the right predicate via a conditional PUT that preserves every
 * unrelated triple and surfaces 412/403 clearly.
 *
 * It is mounted as the "Edit" mode of the view-switcher tray; the read-only card
 * stays the default. When no edit map exists for the matched view (or no viewer
 * matches), it falls back to a resolved auto-form over the document's subjects.
 */
import { useMemo } from "react";
import type { LoadedResource } from "@/components/use-resource";
import { editableSubjects } from "@/lib/forms/editable-subjects";
import { editFieldsFor } from "@/lib/forms/edit-map";
import { autoFormFor } from "@/lib/forms/auto-form";
import { FormRenderer } from "@/components/forms/form-renderer";
import { Separator } from "@/components/ui/separator";

export interface EditableTypedViewProps {
  resource: LoadedResource;
  /** Re-fetch the resource (passed to each form for stale-ETag recovery). */
  onReload?: () => void;
}

export function EditableTypedView({ resource, onReload }: EditableTypedViewProps) {
  const editable = useMemo(() => {
    if (!resource.dataset) return undefined;
    return editableSubjects(resource.url, resource.dataset, resource.categoryId);
  }, [resource.dataset, resource.url, resource.categoryId]);

  if (!resource.dataset) return null;

  // The matched view's edit map, or an auto-form per subject when none exists.
  const viewerFields = editable ? editFieldsFor(editable.viewerId) : undefined;

  const subjects =
    editable?.subjects ??
    // No typed viewer: edit the document's own subject (the resource URL).
    [{ id: resource.url, label: resource.url }];

  return (
    <div className="flex flex-col gap-4">
      {subjects.map((subject, i) => {
        const fields = viewerFields ?? autoFormFor(resource.dataset!, subject.id);
        return (
          <div key={subject.id} className="flex flex-col gap-2">
            {subjects.length > 1 && (
              <p className="text-sm font-medium leading-tight">{subject.label}</p>
            )}
            <FormRenderer
              url={resource.url}
              dataset={resource.dataset!}
              subject={subject.id}
              fields={fields}
              etag={resource.etag ?? null}
              source={viewerFields ? "typed-view" : "auto"}
              onReload={onReload}
            />
            {i < subjects.length - 1 && <Separator />}
          </div>
        );
      })}
    </div>
  );
}
