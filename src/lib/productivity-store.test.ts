import { describe, it, expect } from "vitest";
import { DataFactory, Store } from "n3";
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_WEBID,
} from "./integrations/core/testing.js";
import { ItemReadError } from "./errors.js";
import { TypeIndexDataset } from "./type-index.js";
import { createStore, toSlug, type StoreConfig } from "./productivity-store.js";

const SCHEMA = "https://schema.org/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const WIDGET_CLASS = `${SCHEMA}Widget`;

interface Widget {
  name: string;
}

class WidgetDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(WIDGET_CLASS);
    return this;
  }
  get name(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}name`, LiteralAs.string);
  }
  set name(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}name`, v, LiteralFrom.string);
  }
}

const CONFIG: StoreConfig<Widget> = {
  containerSlug: "widgets/",
  forClass: WIDGET_CLASS,
  prefixes: { schema: SCHEMA },
  parse: (url, ds) => {
    const doc = new WidgetDoc(`${url}#it`, ds, DataFactory);
    if (!doc.types.has(WIDGET_CLASS)) return undefined;
    return { name: doc.name ?? "" };
  },
  build: (url, data) => {
    const store = new Store();
    const doc = new WidgetDoc(`${url}#it`, store, DataFactory).mark();
    doc.name = data.name || undefined;
    return store;
  },
};

function store(pod = createMemoryPod()) {
  return {
    pod,
    s: createStore(CONFIG, { podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch }),
  };
}

describe("toSlug", () => {
  it("produces a URI-safe, colon-free, lowercase slug", () => {
    expect(toSlug("My First Note!")).toBe("my-first-note");
    expect(toSlug("a/b:c")).toBe("a-b-c");
    expect(toSlug("Café déjà vu")).toBe("cafe-deja-vu");
  });
  it("returns empty string for unusable input", () => {
    expect(toSlug(undefined)).toBe("");
    expect(toSlug("   ")).toBe("");
    expect(toSlug("***")).toBe("");
  });
  it("never contains a colon", () => {
    expect(toSlug("10:30 meeting")).not.toContain(":");
  });
});

describe("ProductivityStore CRUD", () => {
  it("create registers the container in the type index and writes the item", async () => {
    const { pod, s } = store();
    const { url, etag } = await s.create({ name: "Hello" }, "Hello");

    expect(url.startsWith(`${TEST_POD_ROOT}widgets/`)).toBe(true);
    expect(url.endsWith(".ttl")).toBe(true);
    expect(etag).toBeTruthy();

    // Item is stored and stamped with the class.
    expect(pod.get(url)).toContain("Widget");
    expect(pod.get(url)).toContain('"Hello"');

    // Type index now points the class at the container.
    const indexUrl = `${TEST_POD_ROOT}settings/privateTypeIndex.ttl`;
    const index = new TypeIndexDataset(pod.dataset(indexUrl), DataFactory);
    expect(index.locate(WIDGET_CLASS)).toEqual([
      { forClass: WIDGET_CLASS, instance: undefined, container: `${TEST_POD_ROOT}widgets/` },
    ]);
  });

  it("create is create-only: it never overwrites an existing url", async () => {
    const { s } = store();
    // Two creates land at distinct urls (random suffix), so both succeed.
    const a = await s.create({ name: "A" }, "same");
    const b = await s.create({ name: "B" }, "same");
    expect(a.url).not.toBe(b.url);
  });

  it("read parses a stored item and returns its etag", async () => {
    const { s } = store();
    const { url } = await s.create({ name: "Readable" });
    const item = await s.read(url);
    expect(item?.data.name).toBe("Readable");
    expect(item?.etag).toBeTruthy();
  });

  it("read throws a typed ItemReadError (404) for a missing resource", async () => {
    const { s } = store();
    await expect(s.read(`${TEST_POD_ROOT}widgets/missing.ttl`)).rejects.toSatisfy(
      (e: unknown) => e instanceof ItemReadError && e.status === 404,
    );
  });

  it("list returns every parseable item and skips foreign resources", async () => {
    const { pod, s } = store();
    await s.create({ name: "One" });
    await s.create({ name: "Two" });
    // A non-widget resource in the same container must be ignored.
    await pod.fetch(`${TEST_POD_ROOT}widgets/foreign.ttl`, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `<${TEST_POD_ROOT}widgets/foreign.ttl#it> <${SCHEMA}name> "Nope" .`,
    });

    const items = await s.list();
    expect(items.map((i) => i.data.name).sort()).toEqual(["One", "Two"]);
  });

  it("list returns [] when the container does not exist yet", async () => {
    const { s } = store();
    expect(await s.list()).toEqual([]);
  });

  it("update overwrites with If-Match and surfaces a new etag", async () => {
    const { pod, s } = store();
    const { url, etag } = await s.create({ name: "Before" });
    const { etag: newEtag } = await s.update(url, { name: "After" }, etag);
    expect(pod.get(url)).toContain('"After"');
    expect(pod.get(url)).not.toContain('"Before"');
    expect(newEtag).toBeTruthy();
  });

  it("update with a stale etag fails (412) instead of clobbering", async () => {
    const { s } = store();
    const { url } = await s.create({ name: "v1" });
    await expect(
      s.update(url, { name: "v2" }, '"stale"'),
    ).rejects.toMatchObject({ status: 412 });
  });

  it("remove deletes the item and is idempotent", async () => {
    const { pod, s } = store();
    const { url } = await s.create({ name: "Doomed" });
    await s.remove(url);
    expect(pod.get(url)).toBeUndefined();
    // Deleting again does not throw (404 → success).
    await expect(s.remove(url)).resolves.toBeUndefined();
  });
});
