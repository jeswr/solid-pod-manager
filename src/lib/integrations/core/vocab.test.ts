import { describe, expect, it } from "vitest";
import { DataFactory, Store, Writer } from "n3";
import { safeIri, PodThing } from "./vocab.js";

describe("safeIri (RDF/IRI injection guard — security review F-1)", () => {
  it("passes legitimate http(s) URLs unchanged", () => {
    expect(safeIri("https://store.steampowered.com/app/440")).toBe(
      "https://store.steampowered.com/app/440",
    );
    expect(safeIri("https://x.example/profiles/123")).toBe("https://x.example/profiles/123");
  });

  it("passes undefined through (optional property)", () => {
    expect(safeIri(undefined)).toBeUndefined();
  });

  it("drops a value that would break out of the IRI and inject triples", () => {
    // The Steam-export payload from the review: spaces + <>" let an attacker
    // close the <…> and add their own triples. n3 does not escape these in IRIs.
    const payload = "123> . <https://victim/profile#me> <http://e/p> <http://evil/o";
    expect(safeIri(payload)).toBeUndefined();
    expect(safeIri('a"b')).toBeUndefined();
    expect(safeIri("a<b")).toBeUndefined();
    expect(safeIri("has space")).toBeUndefined();
  });

  it("neutralises the injection end-to-end (no extra triples serialised)", async () => {
    const store = new Store();
    const thing = new PodThing("https://pod.example/me/integrations/steam/games#g1", store, DataFactory);
    thing.sourceUrl = "123> . <https://victim/p#me> <http://e/p> <http://evil/o";

    const ttl = await new Promise<string>((resolve, reject) => {
      const w = new Writer();
      for (const q of store) w.addQuad(q);
      w.end((err, res) => (err ? reject(err) : resolve(res)));
    });
    // The malicious value was dropped, so no schema:url triple and no victim IRI.
    expect(ttl).not.toContain("victim");
    expect(ttl).not.toContain("evil");
  });
});
