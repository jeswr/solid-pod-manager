"use client";

import { useEffect, useState } from "react";
import { parseRdf } from "@jeswr/fetch-rdf";
import { useSession } from "@/components/session-provider";
import { chooseViewer, type ViewerChoice } from "@/lib/viewers";
import { readResourceProperties, type PropertyGroup } from "@/lib/resource-view";

/** A fetched resource ready to render: its viewer choice + decoded content. */
export interface LoadedResource {
  url: string;
  viewer: ViewerChoice;
  contentType?: string;
  size?: number;
  /** Decoded text body (for text/RDF kinds). */
  text?: string;
  /** Parsed RDF property groups (for the `rdf` kind). */
  properties?: PropertyGroup[];
}

/**
 * Fetch a single pod resource for the detail view. Uses the auth-patched global
 * `fetch` (no `fetch` arg passed anywhere) so protected resources upgrade
 * transparently. Only text/RDF bodies are read into memory; binary kinds are
 * left to the browser (the viewer points an `<img>`/`<object>` at the URL).
 */
export function useResource(url: string): {
  data?: LoadedResource;
  error?: Error;
  loading: boolean;
} {
  const { status } = useSession();
  const [state, setState] = useState<{
    data?: LoadedResource;
    error?: Error;
    loading: boolean;
  }>({ loading: true });

  useEffect(() => {
    if (status !== "logged-in") return;
    let cancelled = false;
    setState({ loading: true });

    (async () => {
      const res = await fetch(url, { headers: { accept: "*/*" } });
      if (!res.ok) {
        throw Object.assign(new Error(`Request failed (${res.status})`), {
          status: res.status,
        });
      }
      const contentType = res.headers.get("content-type") ?? undefined;
      const sizeHeader = res.headers.get("content-length");
      const size = sizeHeader ? Number(sizeHeader) : undefined;
      const viewer = chooseViewer(contentType, url);

      const loaded: LoadedResource = { url, viewer, contentType, size };

      if (viewer.kind === "rdf") {
        const body = await res.text();
        loaded.text = body;
        const dataset = await parseRdf(body, viewer.mediaType, { baseIRI: url });
        loaded.properties = readResourceProperties(url, dataset);
      } else if (viewer.kind === "text" && viewer.embeddable) {
        loaded.text = await res.text();
      }
      // Binary kinds (image/pdf/audio/video/generic): no body read — the viewer
      // references the URL directly, keeping memory and bandwidth low.

      if (!cancelled) setState({ loading: false, data: loaded });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [url, status]);

  return state;
}
