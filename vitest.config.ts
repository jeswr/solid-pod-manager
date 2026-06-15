import { defineConfig, type Plugin } from "vitest/config";
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

// Vitest covers the data layer (`src/lib/**`) plus the serving script
// (`scripts/*.test.mjs` spawns scripts/serve-static.mjs as a real process).
// The e2e suite (Playwright, `e2e/**`) starts a real CSS and drives the
// browser — keep the two runners fully separate so `vitest run` never tries
// to execute a `*.spec.ts` e2e file.
export default defineConfig({
  plugins: [rawTurtle()],
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
