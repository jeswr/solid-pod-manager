import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config) {
    // The data layer (`src/lib/`) uses explicit `.js` extensions on relative
    // imports — correct for Node's ESM resolver (and what tsc/vitest expect),
    // but webpack needs to be told that a `./foo.js` specifier may resolve to a
    // `./foo.ts` source. This keeps both toolchains happy without rewriting the
    // vendored Solid library code.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
