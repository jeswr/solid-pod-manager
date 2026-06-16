// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * An intentionally-empty module used as a browser replacement for Node-only
 * specifiers that are never actually reached in the browser at runtime.
 *
 * Specifically, `@jeswr/federation-client`'s SSRF guard does a LAZY
 * `import("node:dns/promises")` inside a code path gated behind a Node-only
 * `hasNodeDns()` check; in the browser that path is never taken (the registry
 * fetch runs with `allowUnresolvedHosts`), so the import only needs to RESOLVE,
 * not provide anything. `next.config.ts` rewrites `node:dns/promises` to this
 * module for the static-export bundle. A default export keeps `import x from`
 * forms valid too.
 */
const emptyModule = {} as Record<string, never>;
export default emptyModule;
