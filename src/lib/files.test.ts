// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import {
  asContainerUrl,
  isContainerUrl,
  isDirectChild,
  parentContainer,
  breadcrumbs,
  toFileSlug,
  childResourceUrl,
  childContainerUrl,
  readRaw,
  readBytes,
  writeRaw,
  createContainer,
  uploadFile,
  deleteEntry,
  copyResource,
  renameResource,
  checkTurtleSyntax,
  isTurtleEditable,
  fileBaseName,
  fileExtension,
  guessContentType,
  listFolder,
  uploadFileName,
  extensionChain,
  isAuxiliaryResource,
} from "./files.js";
import { ResourceWriteError, ResourceDeleteError, ItemReadError } from "./errors.js";

const POD = "https://alice.example/";

describe("path helpers", () => {
  it("normalises and detects container URLs", () => {
    expect(asContainerUrl("https://a.example/x")).toBe("https://a.example/x/");
    expect(asContainerUrl("https://a.example/x/")).toBe("https://a.example/x/");
    expect(isContainerUrl("https://a.example/x/")).toBe(true);
    expect(isContainerUrl("https://a.example/x.ttl")).toBe(false);
  });

  it("computes the parent container, stopping at the storage root", () => {
    expect(parentContainer("https://alice.example/docs/a.ttl", POD)).toBe(
      "https://alice.example/docs/",
    );
    expect(parentContainer("https://alice.example/docs/sub/", POD)).toBe(
      "https://alice.example/docs/",
    );
    // A direct child of root → root is the parent.
    expect(parentContainer("https://alice.example/a.ttl", POD)).toBe(POD);
    // At/above the root → nothing to go up to.
    expect(parentContainer(POD, POD)).toBeUndefined();
    // Different origin → refused.
    expect(parentContainer("https://evil.example/x.ttl", POD)).toBeUndefined();
  });

  it("builds an inclusive breadcrumb trail from root to current", () => {
    const trail = breadcrumbs("https://alice.example/docs/sub/", POD);
    expect(trail.map((c) => c.label)).toEqual(["Pod", "docs", "sub"]);
    expect(trail.map((c) => c.url)).toEqual([
      "https://alice.example/",
      "https://alice.example/docs/",
      "https://alice.example/docs/sub/",
    ]);
  });

  it("returns just the root crumb at root or outside it", () => {
    expect(breadcrumbs(POD, POD)).toHaveLength(1);
    expect(breadcrumbs("https://evil.example/x/", POD)).toHaveLength(1);
  });

  it("decodes percent-encoded segments in breadcrumb labels", () => {
    const trail = breadcrumbs("https://alice.example/My%20Docs/", POD);
    expect(trail.at(-1)?.label).toBe("My Docs");
  });
});

describe("isDirectChild (SEC-1 listing guard)", () => {
  const C = "https://alice.example/docs/";
  it("accepts a direct child resource or container", () => {
    expect(isDirectChild("https://alice.example/docs/a.ttl", C)).toBe(true);
    expect(isDirectChild("https://alice.example/docs/sub/", C)).toBe(true);
  });
  it("rejects the container itself", () => {
    expect(isDirectChild(C, C)).toBe(false);
  });
  it("rejects a grandchild (not direct)", () => {
    expect(isDirectChild("https://alice.example/docs/sub/x.ttl", C)).toBe(false);
  });
  it("rejects a cross-origin member (hostile ldp:contains)", () => {
    expect(isDirectChild("https://evil.example/x.ttl", C)).toBe(false);
  });
  it("rejects a sibling outside the container", () => {
    expect(isDirectChild("https://alice.example/other/a.ttl", C)).toBe(false);
  });
});

describe("slug + child URL minting", () => {
  it("slugs to URI-safe, colon-free, lower-case", () => {
    expect(toFileSlug("My Photo! 2026")).toBe("my-photo-2026");
    expect(toFileSlug("a:b/c")).toBe("a-b-c");
    expect(toFileSlug("résumé")).toBe("resume");
    expect(toFileSlug("notes.ttl")).toBe("notes.ttl"); // dots kept
    expect(toFileSlug("   ")).toBe("");
  });

  it("mints a child resource URL, appending an extension when absent", () => {
    expect(childResourceUrl(POD, "Shopping List", "ttl")).toBe(
      "https://alice.example/shopping-list.ttl",
    );
    // Already has an extension → not doubled.
    expect(childResourceUrl(POD, "data.json", "ttl")).toBe(
      "https://alice.example/data.json",
    );
  });

  it("mints a child container URL ending in slash", () => {
    expect(childContainerUrl(POD, "Holiday Photos")).toBe(
      "https://alice.example/holiday-photos/",
    );
  });

  it("throws on a name that slugs to empty", () => {
    expect(() => childResourceUrl(POD, "!!!", "ttl")).toThrow();
    expect(() => childContainerUrl(POD, "///")).toThrow();
  });
});

describe("file name helpers", () => {
  it("splits base name and extension", () => {
    expect(fileBaseName("a.b.ttl")).toBe("a.b");
    expect(fileExtension("a.b.TTL")).toBe("ttl");
    expect(fileBaseName("noext")).toBe("noext");
    expect(fileExtension("noext")).toBe("");
  });
  it("guesses content type from extension", () => {
    expect(guessContentType("x.ttl")).toBe("text/turtle");
    expect(guessContentType("x.png")).toBe("image/png");
    expect(guessContentType("x.unknown")).toBeUndefined();
  });
  it("extracts the full extension chain", () => {
    expect(extensionChain("archive.tar.gz")).toBe(".tar.gz");
    expect(extensionChain("photo.jpg")).toBe(".jpg");
    expect(extensionChain("noext")).toBe("");
    expect(extensionChain(".gitignore")).toBe(""); // dot-file, no real extension
  });
});

describe("uploadFileName", () => {
  it("preserves a multi-part extension chain", () => {
    expect(uploadFileName("Backup Archive.tar.gz")).toBe("backup-archive.tar.gz");
  });
  it("keeps the extension even when the base is very long (no truncation)", () => {
    const longBase = "a".repeat(200);
    const out = uploadFileName(`${longBase}.gz`);
    expect(out.endsWith(".gz")).toBe(true);
    // Base capped (toFileSlug caps at 64), extension intact.
    expect(out.length).toBeLessThan(longBase.length);
  });
  it("handles a name with no extension", () => {
    expect(uploadFileName("README")).toBe("readme");
  });
  it("throws on a name that slugs to empty", () => {
    expect(() => uploadFileName("!!!")).toThrow();
  });
});

describe("readRaw", () => {
  it("returns text, content-type and etag", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("<#a> <#b> <#c> .", {
        status: 200,
        headers: { "content-type": "text/turtle", etag: '"v1"' },
      });
    const r = await readRaw("https://alice.example/a.ttl", fetchImpl);
    expect(r.text).toContain("<#a>");
    expect(r.contentType).toBe("text/turtle");
    expect(r.etag).toBe('"v1"');
  });

  it("throws ItemReadError with the status on a non-2xx", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 403 });
    await expect(readRaw("https://alice.example/a.ttl", fetchImpl)).rejects.toSatisfy(
      (e: unknown) => e instanceof ItemReadError && e.status === 403,
    );
  });
});

describe("writeRaw", () => {
  it("PUTs with the given content-type and returns the new etag", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(null, { status: 201, headers: { etag: '"v2"' } });
    };
    const { etag } = await writeRaw("https://alice.example/a.txt", "hello", {
      contentType: "text/plain",
      fetchImpl,
    });
    expect(captured?.init.method).toBe("PUT");
    expect((captured?.init.headers as Record<string, string>)["content-type"]).toBe(
      "text/plain",
    );
    expect(captured?.init.body).toBe("hello");
    expect(etag).toBe('"v2"');
  });

  it("sends If-Match for a conditional save and If-None-Match for create-only", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = async (_i, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 205 });
    };
    await writeRaw("https://alice.example/a.ttl", "x", { etag: '"v1"', fetchImpl });
    await writeRaw("https://alice.example/b.ttl", "x", { createOnly: true, fetchImpl });
    expect(seen[0]["if-match"]).toBe('"v1"');
    expect(seen[1]["if-none-match"]).toBe("*");
  });

  it("throws ResourceWriteError carrying the status (e.g. 412 conflict)", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 412 });
    await expect(
      writeRaw("https://alice.example/a.ttl", "x", { fetchImpl }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ResourceWriteError && e.status === 412);
  });

  it("defaults the content type to text/turtle", async () => {
    let ct: string | undefined;
    const fetchImpl: typeof fetch = async (_i, init) => {
      ct = (init?.headers as Record<string, string>)["content-type"];
      return new Response(null, { status: 201 });
    };
    await writeRaw("https://alice.example/a.ttl", "<#a> <#b> <#c> .", { fetchImpl });
    expect(ct).toBe("text/turtle");
  });
});

describe("createContainer", () => {
  it("PUTs a trailing-slash URL with the LDP container Link and create-only guard", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(null, { status: 201 });
    };
    await createContainer("https://alice.example/photos", fetchImpl);
    expect(captured?.url).toBe("https://alice.example/photos/");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.link).toContain("BasicContainer");
    expect(headers["if-none-match"]).toBe("*");
  });

  it("throws ResourceWriteError when the folder already exists (412)", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 412 });
    await expect(
      createContainer("https://alice.example/photos/", fetchImpl),
    ).rejects.toBeInstanceOf(ResourceWriteError);
  });
});

describe("uploadFile", () => {
  it("derives a safe child URL and sends the file's own MIME type", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(null, { status: 201 });
    };
    const file = new File(["bytes"], "Holiday Photo.PNG", { type: "image/png" });
    const { url } = await uploadFile("https://alice.example/photos/", file, { fetchImpl });
    expect(url).toBe("https://alice.example/photos/holiday-photo.png");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("image/png");
    expect(headers["if-none-match"]).toBe("*"); // create-only by default
  });

  it("falls back to the extension MIME map when the File has no type", async () => {
    let ct: string | undefined;
    const fetchImpl: typeof fetch = async (_i, init) => {
      ct = (init?.headers as Record<string, string>)["content-type"];
      return new Response(null, { status: 201 });
    };
    const file = new File(["@prefix x: <#> ."], "data.ttl", { type: "" });
    await uploadFile("https://alice.example/", file, { fetchImpl });
    expect(ct).toBe("text/turtle");
  });

  it("preserves a multi-extension file name (.tar.gz not truncated)", async () => {
    let url = "";
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return new Response(null, { status: 201 });
    };
    const file = new File(["x"], "Backup Archive.tar.gz", { type: "application/gzip" });
    await uploadFile("https://alice.example/", file, { fetchImpl });
    expect(url).toBe("https://alice.example/backup-archive.tar.gz");
  });

  it("can overwrite when asked (no create-only guard)", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl: typeof fetch = async (_i, init) => {
      headers = init?.headers as Record<string, string>;
      return new Response(null, { status: 205 });
    };
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await uploadFile("https://alice.example/", file, { overwrite: true, fetchImpl });
    expect(headers["if-none-match"]).toBeUndefined();
  });
});

describe("deleteEntry", () => {
  it("resolves on 2xx and treats 404/410 as success", async () => {
    const ok: typeof fetch = async () => new Response(null, { status: 205 });
    const gone: typeof fetch = async () => new Response(null, { status: 410 });
    await expect(deleteEntry("https://alice.example/a.ttl", ok)).resolves.toBeUndefined();
    await expect(deleteEntry("https://alice.example/a.ttl", gone)).resolves.toBeUndefined();
  });
  it("throws ResourceDeleteError on a non-empty-container 409", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 409 });
    await expect(
      deleteEntry("https://alice.example/docs/", fetchImpl),
    ).rejects.toSatisfy((e: unknown) => e instanceof ResourceDeleteError && e.status === 409);
  });
});

describe("copyResource", () => {
  it("reads source bytes and writes them create-only to the destination", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input), body: init?.body });
      if (method === "GET") {
        return new Response("hello world", {
          status: 200,
          headers: { "content-type": "text/plain", etag: '"v1"' },
        });
      }
      return new Response(null, { status: 201 });
    };
    await copyResource(
      "https://alice.example/a.txt",
      "https://alice.example/copy/a.txt",
      fetchImpl,
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("https://alice.example/copy/a.txt");
    // Byte-exact: the destination body is a Blob, content preserved.
    expect(put?.body).toBeInstanceOf(Blob);
    expect(await (put?.body as Blob).text()).toBe("hello world");
  });

  it("preserves binary bytes (no text round-trip corruption)", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]); // PNG-ish, invalid UTF-8
    let putBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png", etag: '"v1"' },
        });
      }
      putBody = init?.body;
      return new Response(null, { status: 201 });
    };
    await copyResource(
      "https://alice.example/a.png",
      "https://alice.example/copy/a.png",
      fetchImpl,
    );
    const out = new Uint8Array(await (putBody as Blob).arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });
});

describe("renameResource", () => {
  it("copies then deletes the source (move semantics)", async () => {
    const ops: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      ops.push(`${method} ${String(input)}`);
      if (method === "GET") {
        return new Response("data", {
          status: 200,
          headers: { "content-type": "text/turtle", etag: '"v1"' },
        });
      }
      return new Response(null, { status: method === "DELETE" ? 205 : 201 });
    };
    await renameResource(
      "https://alice.example/old.ttl",
      "https://alice.example/new.ttl",
      fetchImpl,
    );
    expect(ops).toEqual([
      "GET https://alice.example/old.ttl",
      "PUT https://alice.example/new.ttl",
      "DELETE https://alice.example/old.ttl",
    ]);
  });

  it("does NOT delete the source if the destination write fails (fail-safe)", async () => {
    const ops: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      ops.push(method);
      if (method === "GET") {
        return new Response("data", {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (method === "PUT") return new Response(null, { status: 412 }); // target exists
      return new Response(null, { status: 205 });
    };
    await expect(
      renameResource(
        "https://alice.example/old.ttl",
        "https://alice.example/new.ttl",
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(ResourceWriteError);
    expect(ops).not.toContain("DELETE"); // source untouched
  });

  it("refuses to rename a container", async () => {
    await expect(
      renameResource("https://alice.example/docs/", "https://alice.example/docs2/"),
    ).rejects.toThrow();
  });
});

describe("checkTurtleSyntax", () => {
  it("accepts valid Turtle", () => {
    const r = checkTurtleSyntax(
      "@prefix s: <https://schema.org/> . <#a> s:name \"Hi\" .",
    );
    expect(r.ok).toBe(true);
  });
  it("rejects malformed Turtle with a message", () => {
    const r = checkTurtleSyntax("<#a> <#b> .");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});

describe("isTurtleEditable", () => {
  it("is true for Turtle-family RDF, false otherwise", () => {
    expect(isTurtleEditable("text/turtle; charset=utf-8")).toBe(true);
    expect(isTurtleEditable("application/n-triples")).toBe(true);
    expect(isTurtleEditable("text/plain")).toBe(false);
    expect(isTurtleEditable(undefined)).toBe(false);
  });
});

describe("listFolder", () => {
  it("delegates to listContainer (folders-first, name-sorted)", async () => {
    const ttl = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <https://alice.example/docs/> a ldp:Container ;
        ldp:contains <https://alice.example/docs/z.ttl>, <https://alice.example/docs/sub/> .
      <https://alice.example/docs/sub/> a ldp:Container .
    `;
    const fetchImpl: typeof fetch = async () =>
      new Response(ttl, { status: 200, headers: { "content-type": "text/turtle" } });
    const items = await listFolder("https://alice.example/docs/", fetchImpl);
    // Folder sorts before the file.
    expect(items[0]?.isContainer).toBe(true);
    expect(items.map((i) => i.url)).toContain("https://alice.example/docs/z.ttl");
  });

  it("filters out a hostile cross-origin ldp:contains member (SEC-1)", async () => {
    const ttl = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <https://alice.example/docs/> a ldp:Container ;
        ldp:contains <https://alice.example/docs/ok.ttl>,
                     <https://evil.example/steal.ttl>,
                     <https://alice.example/other/sibling.ttl> .
    `;
    const fetchImpl: typeof fetch = async () =>
      new Response(ttl, { status: 200, headers: { "content-type": "text/turtle" } });
    const items = await listFolder("https://alice.example/docs/", fetchImpl);
    const urls = items.map((i) => i.url);
    expect(urls).toContain("https://alice.example/docs/ok.ttl");
    expect(urls).not.toContain("https://evil.example/steal.ttl");
    expect(urls).not.toContain("https://alice.example/other/sibling.ttl");
  });
});

describe("isAuxiliaryResource", () => {
  it("matches dedicated sidecar auxiliaries (.acl/.meta/.acr)", () => {
    expect(isAuxiliaryResource("https://alice.example/docs/.acl")).toBe(true);
    expect(isAuxiliaryResource("https://alice.example/docs/.meta")).toBe(true);
    expect(isAuxiliaryResource("https://alice.example/docs/.acr")).toBe(true);
  });

  it("matches per-resource auxiliaries (<resource>.acl/.meta)", () => {
    expect(isAuxiliaryResource("https://alice.example/docs/photo.png.acl")).toBe(true);
    expect(isAuxiliaryResource("https://alice.example/docs/notes.ttl.meta")).toBe(true);
  });

  it("matches a container's own auxiliary regardless of trailing slash", () => {
    // The aux URL itself has no trailing slash, but be robust either way.
    expect(isAuxiliaryResource("https://alice.example/docs/.acl/")).toBe(true);
  });

  it("does NOT match primary content", () => {
    expect(isAuxiliaryResource("https://alice.example/docs/photo.png")).toBe(false);
    expect(isAuxiliaryResource("https://alice.example/docs/notes.ttl")).toBe(false);
    expect(isAuxiliaryResource("https://alice.example/docs/sub/")).toBe(false);
    // A file that merely CONTAINS "acl" in its base, but not as the extension.
    expect(isAuxiliaryResource("https://alice.example/docs/aclanthology.pdf")).toBe(false);
    expect(isAuxiliaryResource("https://alice.example/docs/metadata.json")).toBe(false);
  });
});

describe("listFolder auxiliary filtering (#11)", () => {
  const ttl = `
    @prefix ldp: <http://www.w3.org/ns/ldp#> .
    <https://alice.example/docs/> a ldp:Container ;
      ldp:contains <https://alice.example/docs/notes.ttl>,
                   <https://alice.example/docs/.acl>,
                   <https://alice.example/docs/notes.ttl.meta> .
  `;
  const fetchImpl: typeof fetch = async () =>
    new Response(ttl, { status: 200, headers: { "content-type": "text/turtle" } });

  it("hides auxiliary resources by default", async () => {
    const items = await listFolder("https://alice.example/docs/", fetchImpl);
    const urls = items.map((i) => i.url);
    expect(urls).toContain("https://alice.example/docs/notes.ttl");
    expect(urls).not.toContain("https://alice.example/docs/.acl");
    expect(urls).not.toContain("https://alice.example/docs/notes.ttl.meta");
  });

  it("re-includes auxiliaries when includeAuxiliary is true (Advanced options)", async () => {
    const items = await listFolder("https://alice.example/docs/", fetchImpl, true);
    const urls = items.map((i) => i.url);
    expect(urls).toContain("https://alice.example/docs/notes.ttl");
    expect(urls).toContain("https://alice.example/docs/.acl");
    expect(urls).toContain("https://alice.example/docs/notes.ttl.meta");
  });
});

describe("readBytes (byte-exact path)", () => {
  it("returns the body as a Blob without a text decode", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]); // not valid UTF-8
    const fetchImpl: typeof fetch = async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/jpeg", etag: '"v1"' },
      });
    const r = await readBytes("https://alice.example/p.jpg", fetchImpl);
    expect(r.contentType).toBe("image/jpeg");
    expect(r.etag).toBe('"v1"');
    const out = new Uint8Array(await r.blob.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("throws ItemReadError on a non-2xx", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });
    await expect(readBytes("https://alice.example/p.jpg", fetchImpl)).rejects.toSatisfy(
      (e: unknown) => e instanceof ItemReadError && e.status === 404,
    );
  });
});
