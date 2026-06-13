// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { demoImport, TEST_POD_ROOT } from "../integrations/core/testing.js";
import { googlePhotosAdapter } from "../integrations/google-photos/adapter.js";
import { pinterestAdapter } from "../integrations/pinterest/adapter.js";
import { photoViewer, type PhotoModel } from "./photo-view.js";
import { buildContact } from "../contacts.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const PHOTOS_DOC = `${TEST_POD_ROOT}integrations/google-photos/media/photos.ttl`;
const PINS_DOC = `${TEST_POD_ROOT}integrations/pinterest/media/pins.ttl`;
const URL = "https://alice.example/media/m.ttl";

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

/** Real Google Photos adapter output — drive the adapter over its recorded fixtures. */
async function realPhotosCtx(): Promise<ViewerContext> {
  const { pod } = await demoImport(googlePhotosAdapter);
  return ctxFromTurtle(pod.get(PHOTOS_DOC) ?? "", PHOTOS_DOC);
}

/** Real Pinterest adapter output (the media/pins document). */
async function realPinsCtx(): Promise<ViewerContext> {
  const { pod } = await demoImport(pinterestAdapter);
  return ctxFromTurtle(pod.get(PINS_DOC) ?? "", PINS_DOC);
}

describe("photoViewer.matches", () => {
  it("matches a schema:ImageObject document (the class the photo adapters write)", async () => {
    expect(photoViewer.matches(await realPhotosCtx())).toBe(true);
  });

  it("matches a schema:Photograph document", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#p> a schema:Photograph ; schema:name "Beach" .`,
    );
    expect(photoViewer.matches(c)).toBe(true);
  });

  it("matches the legacy http://schema.org/ scheme", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <http://schema.org/>. <${URL}#a> a schema:ImageObject ; schema:name "X" .`,
    );
    expect(photoViewer.matches(c)).toBe(true);
  });

  it("matches an untyped subject by the schema:contentUrl signature predicate (shape rescue)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#a> schema:contentUrl <https://cdn.example/x.jpg> .`,
    );
    expect(photoViewer.matches(c)).toBe(true);
  });

  it("does not match an unrelated (contacts) document", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace", email: "ada@example.com" });
    expect(photoViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("photoViewer.extract — real Google Photos output", () => {
  it("extracts title + hosted contentUrl + dimensions for the ImageObjects (videos excluded)", async () => {
    const { items } = photoViewer.extract(await realPhotosCtx());
    // The fixture has two images + one video; videos are VideoObject, not matched.
    expect(items).toHaveLength(2);
    const sunset = items.find((p) => p.title === "IMG_4821.jpg");
    expect(sunset).toBeDefined();
    expect(sunset?.contentUrl).toBe("https://lh3.googleusercontent.com/lr/AGj1epU8f9k2mNq");
    expect(sunset?.width).toBe(4032);
    expect(sunset?.height).toBe(3024);
  });

  it("derives the Open-in-Google-Photos action from productUrl and suppresses the raw URL", async () => {
    const { items } = photoViewer.extract(await realPhotosCtx());
    const sunset = items.find((p) => p.title === "IMG_4821.jpg");
    expect(sunset?.source?.id).toBe("google-photos");
    expect(sunset?.source?.label).toBe("Open in Google Photos");
    expect(sunset?.source?.href).toBe("https://photos.google.com/lr/photo/AGj1epU8f9k2mNq");
    // No raw url/sourceUrl field on the model — only the action.
    expect(sunset).not.toHaveProperty("url");
    expect(sunset).not.toHaveProperty("sourceUrl");
  });
});

describe("photoViewer.extract — real Pinterest output", () => {
  it("extracts the pin image with the Open-in-Pinterest action", async () => {
    const { items } = photoViewer.extract(await realPinsCtx());
    expect(items.length).toBeGreaterThan(0);
    const desk = items.find((p) => p.title === "Mid-century desk setup");
    expect(desk?.contentUrl).toBe("https://i.pinimg.com/600x/ab/cd/ef.jpg");
    expect(desk?.source?.id).toBe("pinterest");
    expect(desk?.source?.href).toBe("https://www.pinterest.com/pin/813034246246243478/");
  });
});

describe("photoViewer.extract — edge cases", () => {
  it("falls back to 'Untitled photo' when schema:name is absent", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#a> a schema:ImageObject ; schema:contentUrl <https://cdn.example/x.jpg> .`,
    );
    const { items } = photoViewer.extract(c);
    expect(items[0].title).toBe("Untitled photo");
    expect(items[0].contentUrl).toBe("https://cdn.example/x.jpg");
  });

  it("leaves source undefined for an unrecognised host (no raw-URL row)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#a> a schema:ImageObject ; schema:name "Local" ;
         schema:contentUrl <https://cdn.example/x.jpg> ; schema:url <https://example.com/x> .`,
    );
    expect(photoViewer.extract(c).items[0].source).toBeUndefined();
  });

  it("sorts photos by title for a stable, human order", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#b> a schema:ImageObject ; schema:name "Zebra" ; schema:contentUrl <https://cdn.example/z.jpg> .
       <${URL}#a> a schema:ImageObject ; schema:name "Apple" ; schema:contentUrl <https://cdn.example/a.jpg> .`,
    );
    expect(photoViewer.extract(c).items.map((p) => p.title)).toEqual(["Apple", "Zebra"]);
  });
});

describe("selection precedence (Photo vs others)", () => {
  it("a photos document selects the photo viewer", async () => {
    expect(selectTypedViewer(await realPhotosCtx())?.id).toBe("photo");
  });

  it("photo viewer sits at priority 60", () => {
    expect(photoViewer.priority).toBe(60);
  });

  it("a contacts document does not select the photo viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    const _m: PhotoModel = photoViewer.extract(buildViewerContext(URL, ds));
    expect(_m.items).toEqual([]);
  });
});
