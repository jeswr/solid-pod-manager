import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest covers the data layer (`src/lib/**`) plus the serving script
// (`scripts/*.test.mjs` spawns scripts/serve-static.mjs as a real process).
// The e2e suite (Playwright, `e2e/**`) starts a real CSS and drives the
// browser — keep the two runners fully separate so `vitest run` never tries
// to execute a `*.spec.ts` e2e file.
export default defineConfig({
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
