// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Avatar upload (bugs #12/#13): the profile editor can now upload a local image
// into the pod and make it public-readable, instead of only accepting a pasted
// URL. These tests exercise the happy path + the non-fatal public-read fallback
// with a mock `fetch` (no pod required).
import { describe, it, expect } from "vitest";
import { uploadProfilePhoto } from "./profile-photo.js";
import { ResourceWriteError } from "./errors.js";

const POD = "https://alice.example/";
const OWNER = "https://alice.example/profile/card#me";
const AVATAR = "https://alice.example/profile/avatar.png";

/** A root ACL granting the owner Control + an inheritable default. */
const ROOT_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#owner> a acl:Authorization ;
  acl:agent <${OWNER}> ;
  acl:accessTo <${POD}> ; acl:default <${POD}> ;
  acl:mode acl:Read, acl:Write, acl:Control .
`;

interface RecordedReq {
  url: string;
  method: string;
  contentType?: string;
  body: unknown;
}

/**
 * A fake pod. The avatar resource and its `.acl` do not exist yet (the upload
 * creates them); the pod root has an ACL so the inheritance walk terminates and
 * `setAccess` can materialise a resource-specific ACL.
 *
 * `failAclPut` makes ACL writes 403 so the public-read fallback path is tested.
 */
function fakePod(options?: { failAclPut?: boolean; preexisting?: string[] }) {
  const docs = new Map<string, string>();
  docs.set(`${POD}.acl`, ROOT_ACL);
  // Resources that exist and answer ACL discovery with a Link header. The avatar
  // itself starts absent and becomes present after its PUT. `preexisting` seeds
  // stale avatar variants from a previous upload (to test cleanup).
  const resources = new Set<string>([
    POD,
    "https://alice.example/profile/",
    ...(options?.preexisting ?? []),
  ]);
  const reqs: RecordedReq[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    reqs.push({
      url,
      method,
      contentType: headers.get("content-type") ?? undefined,
      body: init?.body,
    });

    if (method === "GET") {
      const aclBody = docs.get(url);
      if (aclBody !== undefined) {
        return new Response(aclBody, {
          status: 200,
          headers: { "content-type": "text/turtle", etag: '"v1"' },
        });
      }
      if (url.endsWith(".acl")) return new Response("missing", { status: 404 });
      if (resources.has(url)) {
        return new Response("", {
          status: 200,
          headers: { link: `<${url}.acl>; rel="acl"`, "content-type": "text/turtle" },
        });
      }
      return new Response("missing", { status: 404 });
    }

    if (method === "PUT") {
      const isAcl = url.endsWith(".acl");
      if (isAcl && options?.failAclPut) {
        return new Response(null, { status: 403 });
      }
      if (isAcl) docs.set(url, String(init?.body));
      else resources.add(url); // the avatar now exists (answers discovery)
      return new Response(null, { status: 201 });
    }

    if (method === "DELETE") {
      const existed = resources.delete(url);
      docs.delete(url);
      return new Response(null, { status: existed ? 205 : 404 });
    }
    return new Response("unexpected", { status: 500 });
  };

  return { fetchImpl, reqs, docs };
}

function pngFile(): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  return new File([bytes], "me.png", { type: "image/png" });
}

describe("uploadProfilePhoto (#12/#13)", () => {
  it("uploads the image to <storage>/profile/avatar.<ext> with its MIME type", async () => {
    const pod = fakePod();
    const { url } = await uploadProfilePhoto(POD, OWNER, pngFile(), {
      fetchImpl: pod.fetchImpl,
    });
    expect(url).toBe(AVATAR);

    const imagePut = pod.reqs.find((r) => r.method === "PUT" && r.url === AVATAR);
    expect(imagePut, "the image bytes are PUT to the avatar URL").toBeTruthy();
    expect(imagePut?.contentType).toBe("image/png");
    expect(imagePut?.body).toBeInstanceOf(File);
  });

  it("grants public read on the uploaded avatar (publicReadStatus granted)", async () => {
    const pod = fakePod();
    const result = await uploadProfilePhoto(POD, OWNER, pngFile(), {
      fetchImpl: pod.fetchImpl,
    });
    expect(result.publicReadGranted).toBe(true);
    expect(result.publicReadStatus).toBe("granted");

    const aclPut = pod.reqs.find((r) => r.method === "PUT" && r.url.endsWith(".acl"));
    expect(aclPut, "a resource-specific ACL is written for the avatar").toBeTruthy();
    expect(aclPut?.url).toBe(`${AVATAR}.acl`);
    // The materialised ACL grants public (foaf:Agent) read, never hand-built —
    // the typed backend wrote it; assert the effect appears in the body.
    expect(String(aclPut?.body)).toContain("foaf:Agent");
  });

  it("still succeeds (publicReadStatus failed) when the ACL write is forbidden", async () => {
    const pod = fakePod({ failAclPut: true });
    const result = await uploadProfilePhoto(POD, OWNER, pngFile(), {
      fetchImpl: pod.fetchImpl,
    });
    // The bytes uploaded; only the public grant failed — never discard a good upload.
    expect(result.url).toBe(AVATAR);
    expect(result.publicReadGranted).toBe(false);
    expect(result.publicReadStatus).toBe("failed");
    expect(pod.reqs.some((r) => r.method === "PUT" && r.url === AVATAR)).toBe(true);
  });

  it("does NOT delete stale variants until the deferred cleanup is run", async () => {
    const stale = "https://alice.example/profile/avatar.jpg";
    const pod = fakePod({ preexisting: [stale] });
    const result = await uploadProfilePhoto(POD, OWNER, pngFile(), {
      fetchImpl: pod.fetchImpl,
    });
    // Cleanup is deferred (caller runs it AFTER saveProfile) — no DELETE yet.
    expect(pod.reqs.some((r) => r.method === "DELETE")).toBe(false);

    await result.cleanupStaleVariants();
    // Now the old variant is DELETEd; the new one is never deleted (roborev).
    expect(pod.reqs.some((r) => r.method === "DELETE" && r.url === stale)).toBe(true);
    expect(pod.reqs.some((r) => r.method === "DELETE" && r.url === AVATAR)).toBe(false);
  });

  it("cleanup is best-effort: it never throws even if every DELETE fails", async () => {
    const stale = "https://alice.example/profile/avatar.jpg";
    const baseFetch = fakePod({ preexisting: [stale] }).fetchImpl;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "DELETE") throw new Error("network");
      return baseFetch(input, init);
    };
    const result = await uploadProfilePhoto(POD, OWNER, pngFile(), { fetchImpl });
    expect(result.url).toBe(AVATAR);
    // Awaiting cleanup resolves (does not reject) despite the failing DELETEs.
    await expect(result.cleanupStaleVariants()).resolves.toBeUndefined();
  });

  it("reports publicReadStatus 'unsupported' on an ACP pod (AcpUnsupportedError)", async () => {
    const pod = fakePod();
    // Force the ACL discovery GET to surface an ACP control document (.acr),
    // which the WAC backend refuses with AcpUnsupportedError.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === AVATAR) {
        return new Response("", {
          status: 200,
          headers: {
            link: `<${AVATAR}.acr>; rel="acl"`,
            "content-type": "text/turtle",
          },
        });
      }
      return pod.fetchImpl(input, init);
    };
    const result = await uploadProfilePhoto(POD, OWNER, pngFile(), { fetchImpl });
    // The image still uploaded; only the public grant is unsupported here.
    expect(result.url).toBe(AVATAR);
    expect(result.publicReadGranted).toBe(false);
    expect(result.publicReadStatus).toBe("unsupported");
  });

  it("rejects a non-image file before any network call", async () => {
    const pod = fakePod();
    const txt = new File(["hi"], "notes.txt", { type: "text/plain" });
    await expect(
      uploadProfilePhoto(POD, OWNER, txt, { fetchImpl: pod.fetchImpl }),
    ).rejects.toThrow(/image/i);
    expect(pod.reqs.length, "no request is made for a rejected file").toBe(0);
  });

  it("propagates a failed image upload as ResourceWriteError", async () => {
    const failingFetch: typeof fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return new Response(null, { status: 403 });
      return new Response("missing", { status: 404 });
    };
    await expect(
      uploadProfilePhoto(POD, OWNER, pngFile(), { fetchImpl: failingFetch }),
    ).rejects.toBeInstanceOf(ResourceWriteError);
  });

  it("derives a safe extension from the file's MIME, not its name", async () => {
    const pod = fakePod();
    // A JPEG whose name has a misleading/unsafe extension.
    const jpeg = new File([new Uint8Array([0xff, 0xd8])], "a/../weird name.JPG", {
      type: "image/jpeg",
    });
    const { url } = await uploadProfilePhoto(POD, OWNER, jpeg, {
      fetchImpl: pod.fetchImpl,
    });
    expect(url).toBe("https://alice.example/profile/avatar.jpg");
  });
});
