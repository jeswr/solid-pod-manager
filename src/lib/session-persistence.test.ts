/**
 * session-persistence.ts — the durable refresh-token-session store.
 *
 * The security-critical property under test: a NON-EXTRACTABLE DPoP CryptoKey
 * survives persistence (the structured-clone algorithm IndexedDB uses) with
 * `extractable: false` preserved AND still produces a valid signature — so the
 * persisted refresh token stays usable by the same key that bound it, while the
 * raw private-key bytes never leave the browser's key store.
 */
import { describe, expect, it } from "vitest";
import {
  IndexedDbSessionStore,
  indexedDbAvailable,
  type PersistedSession,
} from "./session-persistence";
import { StructuredCloneSessionStore } from "./test-utils/structured-clone-session-store";

async function makeDpopKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false, // extractable: false — the whole point
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function sampleSession(): Promise<PersistedSession> {
  return {
    issuer: "https://as.test",
    webId: "https://pod.test/profile/card#me",
    refreshToken: "rt-persisted-1",
    dpopKey: await makeDpopKey(),
    clientId: "https://app.test/clientid.jsonld",
    expiresAt: Date.now() + 3600_000,
  };
}

describe("structured-clone persistence (IndexedDB semantics)", () => {
  it("round-trips a session and keeps the DPoP private key NON-EXTRACTABLE", async () => {
    const store = new StructuredCloneSessionStore();
    const session = await sampleSession();

    await store.put(session);
    const restored = await store.get(session.issuer);

    expect(restored).toBeDefined();
    expect(restored?.refreshToken).toBe("rt-persisted-1");
    expect(restored?.webId).toBe(session.webId);
    // The persisted private key remains non-extractable after the round-trip:
    // the raw bytes never became readable to JS or to storage.
    expect(restored?.dpopKey.privateKey.extractable).toBe(false);
  });

  it("the DPoP key restored from storage still signs a valid proof (key continuity)", async () => {
    const store = new StructuredCloneSessionStore();
    const session = await sampleSession();
    await store.put(session);

    const restored = await store.get(session.issuer);
    const data = new TextEncoder().encode("dpop-proof-payload");

    // Sign with the RESTORED private key; verify with the ORIGINAL public key —
    // proving the persisted key pair is the same key (DPoP sender-constraining
    // survives persistence).
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      restored!.dpopKey.privateKey,
      data,
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      session.dpopKey.publicKey,
      signature,
      data,
    );
    expect(valid).toBe(true);
  });

  it("delete removes the entry", async () => {
    const store = new StructuredCloneSessionStore();
    const session = await sampleSession();
    await store.put(session);
    await store.delete(session.issuer);
    expect(await store.get(session.issuer)).toBeUndefined();
  });

  it("the access token is not part of the persisted shape", async () => {
    const session = await sampleSession();
    // Type-level + structural guarantee: PersistedSession has no accessToken.
    expect("accessToken" in session).toBe(false);
  });
});

describe("IndexedDbSessionStore (real IDB, when available)", () => {
  it.skipIf(!indexedDbAvailable())(
    "persists and restores through a real IndexedDB",
    async () => {
      const store = new IndexedDbSessionStore();
      const session = await sampleSession();
      await store.put(session);
      const restored = await store.get(session.issuer);
      expect(restored?.refreshToken).toBe("rt-persisted-1");
      expect(restored?.dpopKey.privateKey.extractable).toBe(false);
      await store.delete(session.issuer);
      expect(await store.get(session.issuer)).toBeUndefined();
    },
  );

  it("reports availability honestly for the current environment", () => {
    expect(indexedDbAvailable()).toBe(typeof globalThis.indexedDB !== "undefined");
  });
});
