import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is a pure client-side Solid consumer — every page is a
  // prerenderable shell + client data fetching against the user's pod.
  // `next build` therefore emits a fully static site in `out/`, served by any
  // static host (deploy/Caddyfile + Dockerfile). Consequences handled
  // elsewhere:
  // - no middleware → security headers moved to deploy/Caddyfile;
  // - /clientid.jsonld is a force-static route handler (origin baked from
  //   NEXT_PUBLIC_APP_ORIGIN at build time);
  // - dynamic segments either enumerate their params at build time
  //   (generateStaticParams) or were converted to query parameters.
  // trailingSlash stays false: routes export as `<route>.html`, matching the
  // Caddyfile's `try_files {path} {path}.html /index.html`.
  output: "export",
  webpack(config, { webpack }) {
    // The data layer (`src/lib/`) uses explicit `.js` extensions on relative
    // imports — correct for Node's ESM resolver (and what tsc/vitest expect),
    // but webpack needs to be told that a `./foo.js` specifier may resolve to a
    // `./foo.ts` source. This keeps both toolchains happy without rewriting the
    // vendored Solid library code.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    // Vendored SHACL shapes (`src/lib/shacl/shapes/*.ttl`, ADR-0014) are
    // imported as raw Turtle text and parsed at runtime with N3 (browser-safe).
    // `asset/source` inlines the file contents as a string export.
    config.module.rules.push({
      test: /\.ttl$/,
      type: "asset/source",
    });
    // `@jeswr/federation-client`'s inlined SSRF guard statically imports
    // `node:net` (`isIP`) and lazily imports `node:dns/promises` — Node built-ins
    // that don't exist in this pure browser static export, so webpack rejects the
    // `node:` SCHEME outright (before alias resolution). Rewrite those two
    // specifiers via NormalModuleReplacementPlugin: `node:net` → a browser-safe
    // `isIP` shim (so the guard's IP-literal classification works identically),
    // and `node:dns/promises` → an empty stub (only reached behind a Node-only
    // `hasNodeDns()` guard, never in the browser — the registry fetch runs with
    // `allowUnresolvedHosts`, and the browser already mediates the network). The
    // plugin matches ONLY those exact `node:` specifiers, so no app/source module
    // resolution changes. Additive.
    const netShim = new URL("./src/lib/node-net-browser-shim.ts", import.meta.url).pathname;
    const emptyStub = new URL("./src/lib/empty-module.ts", import.meta.url).pathname;
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:net$/, netShim),
      new webpack.NormalModuleReplacementPlugin(/^node:dns\/promises$/, emptyStub),
    );
    return config;
  },
};

export default nextConfig;
