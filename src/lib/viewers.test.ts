import { describe, it, expect } from "vitest";
import { chooseViewer, normaliseMediaType, viewerKindLabel } from "./viewers.js";

describe("normaliseMediaType", () => {
  it("strips parameters and lowercases", () => {
    expect(normaliseMediaType("text/Turtle; charset=utf-8")).toBe("text/turtle");
    expect(normaliseMediaType(undefined)).toBe("");
  });
});

describe("chooseViewer", () => {
  it("classifies RDF as the structured-data viewer", () => {
    expect(chooseViewer("text/turtle").kind).toBe("rdf");
    expect(chooseViewer("application/ld+json").kind).toBe("rdf");
  });

  it("classifies images, pdf, audio, video", () => {
    expect(chooseViewer("image/png").kind).toBe("image");
    expect(chooseViewer("application/pdf").kind).toBe("pdf");
    expect(chooseViewer("audio/mpeg").kind).toBe("audio");
    expect(chooseViewer("video/mp4").kind).toBe("video");
  });

  it("classifies plain text and markdown as text", () => {
    expect(chooseViewer("text/plain").kind).toBe("text");
    expect(chooseViewer("text/markdown").kind).toBe("text");
  });

  it("treats HTML as non-embeddable generic (no live HTML)", () => {
    const v = chooseViewer("text/html");
    expect(v.kind).toBe("generic");
    expect(v.embeddable).toBe(false);
  });

  it("falls back to a SAFE generic, non-embeddable viewer for unknown types", () => {
    const v = chooseViewer("application/x-weird-binary");
    expect(v.kind).toBe("generic");
    expect(v.embeddable).toBe(false);
  });

  it("uses the URL extension when the content-type is missing or octet-stream", () => {
    expect(chooseViewer(undefined, "https://a.example/notes.ttl").kind).toBe("rdf");
    expect(
      chooseViewer("application/octet-stream", "https://a.example/pic.png").kind,
    ).toBe("image");
  });
});

describe("viewerKindLabel", () => {
  it("gives a human label for each kind", () => {
    expect(viewerKindLabel("rdf")).toBe("Structured data");
    expect(viewerKindLabel("generic")).toBe("File");
  });
});
