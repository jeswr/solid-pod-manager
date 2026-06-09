import { describe, it, expect } from "vitest";
import { formatBytes, formatModified } from "./format.js";

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(undefined)).toBeUndefined();
  });
});

describe("formatModified", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  it("labels recent dates relatively", () => {
    expect(formatModified("2026-06-10T09:00:00Z", now)).toBe("today");
    expect(formatModified("2026-06-09T09:00:00Z", now)).toBe("yesterday");
    expect(formatModified("2026-06-07T09:00:00Z", now)).toBe("3 days ago");
  });
  it("falls back to a calendar date for older items", () => {
    expect(formatModified("2025-01-15T09:00:00Z", now)).toMatch(/2025/);
  });
  it("returns undefined for bad input", () => {
    expect(formatModified(undefined, now)).toBeUndefined();
    expect(formatModified("not-a-date", now)).toBeUndefined();
  });
});
