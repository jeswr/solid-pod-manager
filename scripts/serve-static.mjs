#!/usr/bin/env node
/**
 * Zero-dependency static server for the `out/` export with the SAME resolution
 * rule as the production Caddyfile (deploy/Caddyfile):
 *
 *   try_files {path} {path}.html /index.html
 *
 * `next start` cannot serve an `output: "export"` build, so `npm start` and
 * the Playwright webServer use this instead. Keeping the resolution rule
 * identical to Caddy means local serving and e2e exercise the deployed
 * routing behaviour (e.g. `/notes/edit` resolves to `notes/edit.html`).
 *
 * Usage: node scripts/serve-static.mjs [dir=out] [port=3200]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const dir = resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? 3200);

/** Minimal MIME map for what a Next static export actually contains. */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jsonld": "application/ld+json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Resolve a candidate to a readable file (directories → their index.html). */
async function fileAt(path) {
  try {
    const s = await stat(path);
    if (s.isDirectory()) return fileAt(join(path, "index.html"));
    return s.isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    // Malformed request target (e.g. an invalid percent sequence like /%zz):
    // decodeURIComponent throws URIError, and an uncaught throw in this async
    // handler would kill the whole process. Caddy answers 400 and stays up —
    // match that.
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad request");
    return;
  }
  // Traversal guard: never resolve outside the export directory.
  const safe = normalize(join(dir, pathname));
  if (safe !== dir && !safe.startsWith(dir + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  const file =
    (await fileAt(safe)) ?? (await fileAt(`${safe}.html`)) ?? join(dir, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(port, () => {
  // Report the BOUND port (`port` may be 0 = "any free port", used by tests).
  const bound = server.address().port;
  console.log(`Serving ${dir} at http://localhost:${bound} (try_files {path} {path}.html /index.html)`);
});
