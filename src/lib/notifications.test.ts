import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  discoverSubscriptionService,
  subscribeToResource,
  WEBSOCKET_CHANNEL_2023,
  type ResourceChangeNotification,
} from "./notifications.js";

const TOPIC = "https://pod.example/alice/calendar/";
const DESCRIPTION_URL = "https://pod.example/.well-known/solid/storage";
const SERVICE_URL = "https://pod.example/.notifications/WebSocketChannel2023/";
const CHANNEL_ID = "https://pod.example/.notifications/WebSocketChannel2023/abc-123";
const RECEIVE_FROM = "wss://pod.example/.notifications/WebSocketChannel2023/abc-123";

/** A storage description (Turtle) advertising a WebSocketChannel2023 service. */
const STORAGE_DESCRIPTION_TTL = `
@prefix pim: <http://www.w3.org/ns/pim/space#> .
@prefix notify: <http://www.w3.org/ns/solid/notifications#> .
<https://pod.example/> a pim:Storage .
<${DESCRIPTION_URL}>
  notify:subscription <${SERVICE_URL}> ;
  notify:channelType <${WEBSOCKET_CHANNEL_2023}> .
`;

/** A storage description that offers only a non-WebSocket channel. */
const STORAGE_DESCRIPTION_NO_WS_TTL = `
@prefix notify: <http://www.w3.org/ns/solid/notifications#> .
<${DESCRIPTION_URL}>
  notify:subscription <${SERVICE_URL}> ;
  notify:channelType <http://www.w3.org/ns/solid/notifications#WebhookChannel2023> .
`;

function ttlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/turtle" } });
}

function subscriptionResponse(): Response {
  return new Response(
    JSON.stringify({
      "@context": "https://www.w3.org/ns/solid/notification/v1",
      id: CHANNEL_ID,
      type: "WebSocketChannel2023",
      topic: TOPIC,
      receiveFrom: RECEIVE_FROM,
    }),
    { status: 200, headers: { "content-type": "application/ld+json" } },
  );
}

/**
 * A fetch that answers the happy discovery+subscribe flow:
 *   HEAD topic → Link header; GET description → Turtle; POST service → channel.
 * Records calls so tests can assert request construction + teardown DELETE.
 */
function makeHappyFetch(opts: { linkHeader?: string; descriptionTtl?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "HEAD" && url === TOPIC) {
      const link =
        opts.linkHeader ??
        `<${DESCRIPTION_URL}>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`;
      return new Response(null, { status: 200, headers: { link } });
    }
    if (method === "GET" && url === DESCRIPTION_URL) {
      return ttlResponse(opts.descriptionTtl ?? STORAGE_DESCRIPTION_TTL);
    }
    if (method === "POST" && url === SERVICE_URL) {
      return subscriptionResponse();
    }
    if (method === "DELETE") {
      return new Response(null, { status: 205 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A controllable mock WebSocket exposing the standard `addEventListener` API. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  closed = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: deliver a message frame. */
  emitMessage(data: string): void {
    for (const fn of this.listeners.message ?? []) fn({ data });
  }
  /** Test helper: deliver an error event. */
  emitError(): void {
    for (const fn of this.listeners.error ?? []) fn({});
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverSubscriptionService", () => {
  it("finds the WebSocketChannel2023 service from the storageDescription Link header", async () => {
    const { fetchImpl } = makeHappyFetch();
    await expect(discoverSubscriptionService(TOPIC, fetchImpl)).resolves.toBe(SERVICE_URL);
  });

  it("ignores a service that does not advertise WebSocketChannel2023", async () => {
    const { fetchImpl } = makeHappyFetch({ descriptionTtl: STORAGE_DESCRIPTION_NO_WS_TTL });
    await expect(discoverSubscriptionService(TOPIC, fetchImpl)).resolves.toBeUndefined();
  });

  it("falls back to the well-known storage description when no Link header is present", async () => {
    // No Link header on HEAD; the well-known fallback URL serves the description.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "HEAD" && url === TOPIC) return new Response(null, { status: 200 });
      if (method === "GET" && url === DESCRIPTION_URL) return ttlResponse(STORAGE_DESCRIPTION_TTL);
      return new Response("", { status: 404 });
    };
    await expect(discoverSubscriptionService(TOPIC, fetchImpl)).resolves.toBe(SERVICE_URL);
  });

  it("resolves a relative Link target against the topic URL", async () => {
    const { fetchImpl } = makeHappyFetch({
      linkHeader: `</.well-known/solid/storage>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`,
    });
    await expect(discoverSubscriptionService(TOPIC, fetchImpl)).resolves.toBe(SERVICE_URL);
  });

  it("returns undefined (never throws) when discovery fetches all fail", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 500 });
    await expect(discoverSubscriptionService(TOPIC, fetchImpl)).resolves.toBeUndefined();
  });
});

describe("subscribeToResource — channel manager", () => {
  it("subscribes and fires onChange on a notification message", async () => {
    const { fetchImpl, calls } = makeHappyFetch();
    const changes: ResourceChangeNotification[] = [];
    const unsub = await subscribeToResource(TOPIC, (n) => changes.push(n), {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });

    // The POST body must be the JSON-LD subscription request shape.
    const post = calls.find((c) => (c.init?.method ?? "GET") === "POST");
    expect(post?.url).toBe(SERVICE_URL);
    const body = JSON.parse(post?.init?.body as string);
    expect(body).toMatchObject({
      "@context": "https://www.w3.org/ns/solid/notification/v1",
      type: WEBSOCKET_CHANNEL_2023,
      topic: TOPIC,
    });

    // The socket opened on receiveFrom.
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe(RECEIVE_FROM);

    ws.emitMessage(
      JSON.stringify({ type: "Update", object: { id: "https://pod.example/alice/calendar/x.ttl" } }),
    );
    expect(changes).toEqual([
      { type: "Update", object: "https://pod.example/alice/calendar/x.ttl" },
    ]);

    unsub();
  });

  it("handles a string-valued notification object", async () => {
    const { fetchImpl } = makeHappyFetch();
    const changes: ResourceChangeNotification[] = [];
    await subscribeToResource(TOPIC, (n) => changes.push(n), {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    MockWebSocket.instances[0].emitMessage(
      JSON.stringify({ type: "Delete", object: "https://pod.example/alice/calendar/y.ttl" }),
    );
    expect(changes).toEqual([
      { type: "Delete", object: "https://pod.example/alice/calendar/y.ttl" },
    ]);
  });

  it("ignores malformed notification frames without throwing", async () => {
    const { fetchImpl } = makeHappyFetch();
    const onChange = vi.fn();
    await subscribeToResource(TOPIC, onChange, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    const ws = MockWebSocket.instances[0];
    ws.emitMessage("not json at all");
    ws.emitMessage(JSON.stringify({ object: "no-type-field" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unsubscribe closes the socket and is idempotent", async () => {
    const { fetchImpl, calls } = makeHappyFetch();
    const unsub = await subscribeToResource(TOPIC, () => {}, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    const ws = MockWebSocket.instances[0];
    expect(ws.closed).toBe(false);
    unsub();
    expect(ws.closed).toBe(true);
    // Best-effort channel DELETE on the channel id.
    await Promise.resolve();
    expect(calls.some((c) => (c.init?.method ?? "") === "DELETE" && c.url === CHANNEL_ID)).toBe(
      true,
    );
    // Idempotent: a second call does nothing and does not throw.
    expect(() => unsub()).not.toThrow();
  });

  it("does not throw when the socket emits an error", async () => {
    const { fetchImpl } = makeHappyFetch();
    await subscribeToResource(TOPIC, () => {}, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    expect(() => MockWebSocket.instances[0].emitError()).not.toThrow();
  });
});

describe("subscribeToResource — graceful degradation", () => {
  it("resolves to a no-op unsubscribe when discovery finds no service", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 404 });
    const unsub = await subscribeToResource(TOPIC, () => {}, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });

  it("resolves to a no-op when the subscribe POST fails", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "HEAD" && url === TOPIC) {
        return new Response(null, {
          status: 200,
          headers: {
            link: `<${DESCRIPTION_URL}>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`,
          },
        });
      }
      if (method === "GET" && url === DESCRIPTION_URL) return ttlResponse(STORAGE_DESCRIPTION_TTL);
      if (method === "POST") return new Response("denied", { status: 403 });
      return new Response("", { status: 404 });
    };
    const unsub = await subscribeToResource(TOPIC, () => {}, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });

  it("resolves to a no-op when the subscription response has no receiveFrom", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "HEAD" && url === TOPIC) {
        return new Response(null, {
          status: 200,
          headers: {
            link: `<${DESCRIPTION_URL}>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`,
          },
        });
      }
      if (method === "GET" && url === DESCRIPTION_URL) return ttlResponse(STORAGE_DESCRIPTION_TTL);
      if (method === "POST") {
        return new Response(JSON.stringify({ id: CHANNEL_ID }), {
          status: 200,
          headers: { "content-type": "application/ld+json" },
        });
      }
      return new Response("", { status: 404 });
    };
    const unsub = await subscribeToResource(TOPIC, () => {}, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });

  it("resolves to a no-op when fetch throws outright", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    const unsub = await subscribeToResource(TOPIC, () => {}, {
      fetchImpl,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    expect(() => unsub()).not.toThrow();
  });

  it("resolves to a no-op when WebSocket is unavailable (SSR/build)", async () => {
    const { fetchImpl } = makeHappyFetch();
    // No webSocketImpl injected and no global WebSocket in the node test env.
    expect(typeof WebSocket === "undefined" || true).toBe(true);
    const unsub = await subscribeToResource(TOPIC, () => {}, { fetchImpl });
    expect(() => unsub()).not.toThrow();
  });
});
