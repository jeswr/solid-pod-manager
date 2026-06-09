import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest covers ONLY the data layer (`src/lib/**`). The e2e suite (Playwright,
// `e2e/**`) starts a real CSS and drives the browser — keep the two runners
// fully separate so `vitest run` never tries to execute a `*.spec.ts` e2e file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
