import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Import `.ttl` files (the vendored SHACL shapes, ADR-0014) as raw Turtle text,
// matching the webpack `asset/source` rule in next.config.ts so the validator
// loads identically under Vitest and the browser build.
function rawTurtle(): Plugin {
  return {
    name: "raw-turtle",
    transform(_code, id) {
      if (!id.endsWith(".ttl")) return null;
      const ttl = readFileSync(id, "utf8");
      return { code: `export default ${JSON.stringify(ttl)};`, map: null };
    },
  };
}

// Vitest covers the data layer (`src/lib/**`) plus the cache/SWR behaviour of
// hooks under `src/components/**` (asserted against the shared SwrCache — no
// React render, the `node` env has no DOM) and the serving script
// (`scripts/*.test.mjs` spawns scripts/serve-static.mjs as a real process).
// The e2e suite (Playwright, `e2e/**`) starts a real CSS and drives the
// browser — keep the two runners fully separate so `vitest run` never tries
// to execute a `*.spec.ts` e2e file.
export default defineConfig({
  // react() transpiles the `.test.tsx` React render tests (JSX → the automatic
  // react-jsx runtime). The data-layer `.test.ts` suites are plain TS and
  // unaffected. rawTurtle() keeps the vendored SHACL `.ttl` imports working.
  plugins: [react(), rawTurtle()],
  test: {
    // Default to the no-DOM `node` env: the data layer + hook cache tests need
    // no DOM. The handful of React render tests (`*.test.tsx`) opt into jsdom
    // per-file via a `// @vitest-environment jsdom` docblock (Vitest 4 dropped
    // `environmentMatchGlobs`), so only those files pay for a DOM.
    environment: "node",
    // RTL's automatic per-test cleanup (unmount the previous render) keys off
    // the global test hooks, so the `.test.tsx` render tests don't leak DOM
    // between cases. The data-layer suites don't rely on globals, so this is
    // a safe addition.
    globals: true,
    // jest-dom matchers + a `matchMedia` polyfill for the jsdom render tests.
    // Safe to register globally: it only touches `window` when one exists
    // (guarded), so the `node`-env tests are unaffected.
    setupFiles: ["src/test/setup-dom.ts"],
    include: [
      "src/lib/**/*.test.ts",
      "src/components/**/*.test.ts",
      "src/components/**/*.test.tsx",
      "scripts/**/*.test.mjs",
    ],
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // Force a SINGLE React instance across the app + the @jeswr/app-shell
    // package, so the FeedbackButton render test can't trip an
    // invalid-hook-call from app-shell resolving its own nested React copy.
    dedupe: ["react", "react-dom"],
  },
});
