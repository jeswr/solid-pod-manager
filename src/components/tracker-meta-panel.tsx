// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Read-only presentation of a `wf:Tracker` config document's metadata: the
 * tracker's title, issue class, state store, declared categories, assignable
 * group members, and the workflow (its states + allowed transitions). Pure
 * presentation — it takes an already-parsed {@link TrackerMeta} (see lib/tracker
 * + use-tracker) and renders it; it does no fetching and no writing (READ path
 * only). Collapsed by default so it never crowds the issue list.
 */
import { useId, useState } from "react";
import { ChevronDown, GitBranch, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { isHttpUrl, shortIriLabel, type TrackerMeta } from "@/lib/tracker";

/** One metadata field row: a label and its value (or `null` to omit). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined) return null;
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** A mono-styled IRI chip with the full IRI as the title (hover) tooltip. */
function IriChip({ iri }: { iri: string }) {
  return (
    <Badge variant="outline" className="font-mono text-xs" title={iri}>
      {shortIriLabel(iri)}
    </Badge>
  );
}

/**
 * Render a tracker's metadata, collapsed behind a summary toggle. Renders nothing
 * structural beyond the toggle when collapsed; expanding shows the full config.
 */
export function TrackerMetaPanel({ meta }: { meta: TrackerMeta }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const title = meta.title.trim() || "Tracker configuration";

  return (
    <section className="rounded-xl border border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"
        >
          <Settings2 className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            Tracker configuration in your pod
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div id={bodyId} className="flex flex-col gap-5 border-t border-border p-4">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Issue class">
              <IriChip iri={meta.issueClass} />
            </Field>
            {meta.stateStore ? (
              <Field label="State store">
                <span className="font-mono text-xs break-all" title={meta.stateStore}>
                  {meta.stateStore}
                </span>
              </Field>
            ) : null}
            {meta.categories.length > 0 ? (
              <Field label="Categories">
                <span className="flex flex-wrap gap-1.5">
                  {meta.categories.map((c) => (
                    <IriChip key={c} iri={c} />
                  ))}
                </span>
              </Field>
            ) : null}
            {meta.groupMembers.length > 0 ? (
              <Field label="Assignable group">
                <ul className="flex flex-col gap-1">
                  {meta.groupMembers.map((m) => (
                    <li key={m}>
                      {/* Defence-in-depth: `toTrackerMeta` already filters to
                          http(s), but pod RDF is untrusted — only render a LINK
                          for an http(s) WebID; anything else shows as plain text
                          so a non-http scheme can never become an anchor href. */}
                      {isHttpUrl(m) ? (
                        <a
                          href={m}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline underline-offset-2 break-all hover:text-foreground"
                        >
                          {m}
                        </a>
                      ) : (
                        <span className="text-xs break-all text-muted-foreground">{m}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Field>
            ) : null}
          </dl>

          {meta.workflowStates.length > 0 && (
            <div className="flex flex-col gap-2">
              <Separator />
              <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <GitBranch aria-hidden="true" className="size-3.5" />
                Workflow
              </h4>
              <ul className="flex flex-col gap-2" aria-label="Workflow states">
                {meta.workflowStates.map((s) => (
                  <li
                    key={s.slug}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5"
                  >
                    <Badge variant={s.terminal ? "outline" : "default"} className="shrink-0">
                      {s.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {s.resolution === "closed" ? "closed" : "open"}
                    </span>
                    {s.transitionsTo.length > 0 ? (
                      <span className="ml-auto flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <span aria-hidden="true">&rarr;</span>
                        {s.transitionsTo.map((t) => (
                          <Badge key={t} variant="secondary" className="text-xs">
                            {t}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="ml-auto text-xs text-muted-foreground">no transitions</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
