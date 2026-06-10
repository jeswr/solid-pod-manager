"use client";

/**
 * The Tier-C file-import state machine for one integration.
 *
 *   idle → importing → done | error
 *
 * The user picks their official export file; we parse it in the `src/lib`
 * adapter and write the result into the pod through the shared file-import
 * runner (same write path + type-index registration as the OAuth import).
 * Only the parser layer ever reads the file bytes — this hook just hands the
 * `File` through.
 */
import { useCallback, useState } from "react";
import { NoStorageError } from "@/lib/errors";
import type { FileImportAdapter } from "@/lib/integrations/core/file-import";
import { runFileImport } from "@/lib/integrations/core/file-import";
import type { ImportReport } from "@/lib/integrations/core/import-runner";
import type { ImportProgress } from "@/lib/integrations/core/types";
import { useSession } from "./session-provider";

export type FileImportPhase = "idle" | "importing" | "done" | "error";

export interface FileImportState {
  phase: FileImportPhase;
  progress?: ImportProgress;
  report?: ImportReport;
  error?: Error;
  /** The name of the file currently being / last imported (for the UI). */
  fileName?: string;
}

export function useFileImport(adapter: FileImportAdapter | undefined) {
  const { webId, profile, activeStorage } = useSession();
  const [state, setState] = useState<FileImportState>({ phase: "idle" });

  const importFile = useCallback(
    async (file: File) => {
      if (!adapter || !webId) return;
      const podRoot = activeStorage ?? profile?.storages[0];
      if (!podRoot) {
        setState({ phase: "error", error: new NoStorageError(webId), fileName: file.name });
        return;
      }
      setState({ phase: "importing", fileName: file.name });
      try {
        const report = await runFileImport({
          adapter,
          file,
          webId,
          podRoot,
          onProgress: (progress) =>
            setState((s) => ({ ...s, phase: "importing", progress })),
        });
        setState({ phase: "done", report, fileName: file.name });
      } catch (e) {
        setState({
          phase: "error",
          error: e instanceof Error ? e : new Error(String(e)),
          fileName: file.name,
        });
      }
    },
    [adapter, webId, profile, activeStorage],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, importFile, reset };
}
