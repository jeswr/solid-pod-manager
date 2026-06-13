// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, expect, it } from "vitest";
import {
  availableViewModes,
  viewModeOptions,
  initialViewMode,
  shouldShowSwitcher,
} from "./view-modes.js";

describe("availableViewModes", () => {
  it("offers typed + data when a typed view matches", () => {
    expect(availableViewModes({ hasTypedView: true, hasSource: false })).toEqual([
      "typed",
      "data",
    ]);
  });

  it("adds source when an outbound action exists", () => {
    expect(availableViewModes({ hasTypedView: true, hasSource: true })).toEqual([
      "typed",
      "data",
      "source",
    ]);
  });

  it("adds table when the resource holds a tabulatable class", () => {
    expect(
      availableViewModes({ hasTypedView: true, hasSource: false, hasClassTable: true }),
    ).toEqual(["typed", "data", "table"]);
  });

  it("orders modes typed, data, table, source", () => {
    expect(
      availableViewModes({ hasTypedView: true, hasSource: true, hasClassTable: true }),
    ).toEqual(["typed", "data", "table", "source"]);
  });

  it("offers data + table for an untyped resource that has a class table", () => {
    expect(
      availableViewModes({ hasTypedView: false, hasSource: false, hasClassTable: true }),
    ).toEqual(["data", "table"]);
  });

  it("offers nothing for a plain untyped resource (table is the only rendering)", () => {
    expect(availableViewModes({ hasTypedView: false, hasSource: false })).toEqual([]);
  });
});

describe("initialViewMode", () => {
  it("defaults to the typed card whenever one exists (no-raw-RDF-by-default)", () => {
    expect(initialViewMode({ hasTypedView: true, hasSource: false })).toBe("typed");
    expect(initialViewMode({ hasTypedView: true, hasSource: true })).toBe("typed");
    expect(
      initialViewMode({ hasTypedView: true, hasSource: false, hasClassTable: true }),
    ).toBe("typed");
  });

  it("defaults to data when no typed view exists", () => {
    expect(initialViewMode({ hasTypedView: false, hasSource: false })).toBe("data");
    // Even with a class table, the raw table is the documented untyped default;
    // the class table is an opt-in switch, never the landing view.
    expect(
      initialViewMode({ hasTypedView: false, hasSource: false, hasClassTable: true }),
    ).toBe("data");
  });

  it("never lands on source or table", () => {
    expect(initialViewMode({ hasTypedView: true, hasSource: true, hasClassTable: true })).toBe(
      "typed",
    );
  });
});

describe("shouldShowSwitcher", () => {
  it("is shown only when more than one mode is available", () => {
    expect(shouldShowSwitcher({ hasTypedView: true, hasSource: false })).toBe(true);
    expect(shouldShowSwitcher({ hasTypedView: true, hasSource: true })).toBe(true);
    expect(
      shouldShowSwitcher({ hasTypedView: false, hasSource: false, hasClassTable: true }),
    ).toBe(true);
  });

  it("is hidden when there is a single (or zero) rendering", () => {
    expect(shouldShowSwitcher({ hasTypedView: false, hasSource: false })).toBe(false);
  });
});

describe("availableViewModes — edit (Wave 5)", () => {
  it("adds edit after table and before source when canEdit", () => {
    expect(
      availableViewModes({
        hasTypedView: true,
        hasSource: true,
        hasClassTable: true,
        canEdit: true,
      }),
    ).toEqual(["typed", "data", "table", "edit", "source"]);
  });

  it("shows the tray for an untyped resource purely because it is editable", () => {
    expect(availableViewModes({ hasTypedView: false, hasSource: false, canEdit: true })).toEqual([
      "data",
      "edit",
    ]);
    expect(shouldShowSwitcher({ hasTypedView: false, hasSource: false, canEdit: true })).toBe(true);
  });
});

describe("viewModeOptions", () => {
  it("resolves modes to options with labels and icon names, preserving order", () => {
    const opts = viewModeOptions({ hasTypedView: true, hasSource: true, hasClassTable: true });
    expect(opts.map((o) => o.mode)).toEqual(["typed", "data", "table", "source"]);
    expect(opts[0]).toMatchObject({ mode: "typed", label: "Card", icon: "layout-grid" });
    expect(opts[1]).toMatchObject({ mode: "data", label: "Data", icon: "table" });
    expect(opts[2]).toMatchObject({ mode: "table", label: "Table", icon: "table-rows" });
    expect(opts[3]).toMatchObject({ mode: "source", label: "Source", icon: "external-link" });
  });
});
