/**
 * A typed fake fetch built from recorded fixture routes. Powers demo mode in
 * the UI and the adapter contract tests — **no live network ever**: an
 * unmatched request throws instead of hitting the wire.
 */
import { IntegrationSyncError, RateLimitedError } from "./errors.js";
import type { FixtureRoute } from "./types.js";

/** Build a `fetch`-shaped function answering from fixture routes. */
export function fixtureFetch(
  adapterId: string,
  routes: readonly FixtureRoute[],
): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    const route = routes.find(
      (r) => (r.method ?? "GET").toUpperCase() === method && url.startsWith(r.url),
    );
    if (!route) {
      throw new IntegrationSyncError(
        adapterId,
        `No fixture recorded for ${method} ${url} — fixtures must cover every call an import makes.`,
        { url },
      );
    }
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as typeof fetch;
}

/** `GET`/parse JSON with adapter-grade error mapping (429 → RateLimitedError). */
export async function getJson<T>(
  adapterId: string,
  api: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await api(url, init);
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    throw new RateLimitedError(
      adapterId,
      url,
      retryAfter ? Number.parseInt(retryAfter, 10) || undefined : undefined,
    );
  }
  if (!res.ok) {
    throw new IntegrationSyncError(adapterId, `The platform answered ${res.status} for ${url}.`, {
      url,
      status: res.status,
    });
  }
  return (await res.json()) as T;
}

/** `POST` JSON and parse the JSON answer, with the same error mapping. */
export async function postJson<T>(
  adapterId: string,
  api: typeof fetch,
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return getJson<T>(adapterId, api, url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
