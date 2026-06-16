// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Vitest setup for the DOM-environment runs (the `*.test.tsx` component tests
// that render React into jsdom): jest-dom matchers + a `matchMedia` polyfill.
// jsdom ships no `matchMedia`, and the shared @jeswr/app-shell components read
// `prefers-color-scheme`, so a render that mounts them would otherwise throw.
// Mirrors the app-shell package's own setup so component tests behave identically.
import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
