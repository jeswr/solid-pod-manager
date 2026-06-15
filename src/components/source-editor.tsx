// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Raw source editor for a pod resource — SolidOS's source-pane edit→save flow.
 * Loads the literal body, lets the user edit it as text, runs a client-side
 * Turtle syntax check (for RDF content types) before saving, and writes with a
 * conditional `If-Match` on the resource's ETag so a concurrent edit is caught
 * (412) instead of clobbering.
 *
 * House-rule note (CLAUDE.md): for STRUCTURED edits the app uses its typed
 * `@rdfjs/wrapper` helpers, never hand-concatenated Turtle. A *raw source
 * editor* is the explicitly-sanctioned exception — it round-trips the literal
 * body the user typed; it never assembles triples itself.
 *
 * On a 412 the editor re-reads the current server copy, surfaces a clear
 * conflict message with both the latest ETag and the user's unsaved text
 * preserved, and lets the user retry against the fresh version (no silent
 * overwrite, no lost edits).
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Save, RotateCcw, TriangleAlert, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import {
  checkTurtleSyntax,
  isTurtleEditable,
  readRaw,
  writeRaw,
  type RawResource,
} from "@/lib/files";
import { ResourceWriteError, ItemReadError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "syntax"; message: string; line?: number }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export function SourceEditor({ url }: { url: string }) {
  const [raw, setRaw] = useState<RawResource | null>(null);
  const [body, setBody] = useState("");
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // The ETag we will write against — updated after a load/save/conflict re-read.
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    readRaw(url)
      .then((r) => {
        if (cancelled) return;
        setRaw(r);
        setBody(r.text);
        etagRef.current = r.etag;
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const dirty = raw != null && body !== raw.text;
  const turtle = isTurtleEditable(raw?.contentType);

  async function doSave() {
    if (!raw) return;
    // Client-side syntax guard for RDF — catch a typo before the server does.
    if (turtle) {
      const check = checkTurtleSyntax(body, url);
      if (!check.ok) {
        setSave({ kind: "syntax", message: check.message, line: check.line });
        return;
      }
    }
    setSave({ kind: "saving" });
    try {
      const { etag } = await writeRaw(url, body, {
        contentType: raw.contentType ?? "text/turtle",
        etag: etagRef.current,
      });
      etagRef.current = etag;
      // The saved body is now the server truth — rebase the dirty check.
      setRaw({ ...raw, text: body, etag });
      setSave({ kind: "saved" });
      toast.success("Saved to your pod.");
    } catch (e) {
      if (e instanceof ResourceWriteError && e.status === 412) {
        // Someone else changed it. Re-read so the next save has the fresh ETag,
        // but KEEP the user's text (never lose their edits).
        try {
          const fresh = await readRaw(url);
          etagRef.current = fresh.etag;
          setRaw((prev) => (prev ? { ...prev, etag: fresh.etag } : prev));
        } catch {
          // Re-read failed; the user can retry, the next save re-validates.
        }
        setSave({ kind: "conflict" });
        return;
      }
      if (e instanceof ResourceWriteError && (e.status === 401 || e.status === 403)) {
        setSave({ kind: "error", message: "You don't have permission to save changes here." });
        return;
      }
      const msg = e instanceof Error ? e.message : "Couldn't save. Nothing was changed.";
      setSave({ kind: "error", message: msg });
    }
  }

  function revert() {
    if (raw) setBody(raw.text);
    setSave({ kind: "idle" });
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (loadError) {
    const status = loadError instanceof ItemReadError ? loadError.status : undefined;
    return (
      <Alert variant="destructive">
        <TriangleAlert className="size-4" aria-hidden="true" />
        <AlertTitle>Couldn&apos;t open this for editing</AlertTitle>
        <AlertDescription>
          {status === 401 || status === 403
            ? "You don't have permission to edit this resource."
            : status === 404
              ? "This resource no longer exists in your pod."
              : "Something went wrong reading this resource. Try again."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Editing the raw source.{" "}
          {turtle ? "It's checked for Turtle syntax before saving." : null}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || save.kind === "saving"}
            onClick={revert}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Revert
          </Button>
          <Button size="sm" disabled={!dirty || save.kind === "saving"} onClick={() => void doSave()}>
            {save.kind === "saving" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Save
          </Button>
        </div>
      </div>

      {save.kind === "syntax" && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>This isn&apos;t valid Turtle yet</AlertTitle>
          <AlertDescription>
            {save.line ? `Around line ${save.line}: ` : null}
            {save.message}
          </AlertDescription>
        </Alert>
      )}
      {save.kind === "conflict" && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>Someone changed this while you were editing</AlertTitle>
          <AlertDescription>
            Your text is kept. Review it, then press Save again to write over the
            latest version — or Revert to discard your changes.
          </AlertDescription>
        </Alert>
      )}
      {save.kind === "error" && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>Couldn&apos;t save</AlertTitle>
          <AlertDescription>{save.message}</AlertDescription>
        </Alert>
      )}
      {save.kind === "saved" && !dirty && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
          Saved.
        </p>
      )}

      <Textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (save.kind === "saved" || save.kind === "syntax") setSave({ kind: "idle" });
        }}
        spellCheck={false}
        aria-label="Resource source"
        className="min-h-[50vh] font-mono text-xs leading-relaxed"
      />
    </div>
  );
}
