/**
 * Regression tests for scripts/serve-static.mjs — the server that `npm start`
 * and the Playwright webServer use to serve the static export.
 *
 * Spawns the REAL script (port 0 = any free port, parsed from its stdout)
 * against a throwaway export directory, so it pins process-level behaviour a
 * unit test can't: a malformed request must answer 400 and leave the process
 * serving (an uncaught URIError used to kill it — and with it any e2e run).
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = new URL("./serve-static.mjs", import.meta.url).pathname;

let dir;
let child;
let base;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "serve-static-"));
  await writeFile(join(dir, "index.html"), "<h1>shell</h1>");
  await writeFile(join(dir, "page.html"), "<h1>page</h1>");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "index.html"), "<h1>nested</h1>");

  child = spawn(process.execPath, [SCRIPT, dir, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise((resolveUrl, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) resolveUrl(`http://localhost:${m[1]}`);
    });
    child.on("exit", (code) => reject(new Error(`server exited early (code ${code})`)));
  });
}, 15_000);

afterAll(async () => {
  child?.kill();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("serve-static.mjs", () => {
  it("answers 400 to a malformed percent-encoded path and STAYS UP", async () => {
    // WHATWG URL leaves invalid %-sequences untouched, so fetch sends /%zz raw.
    const bad = await fetch(`${base}/%zz`);
    expect(bad.status).toBe(400);

    // The process must survive (regression: uncaught URIError killed it).
    const after = await fetch(`${base}/`);
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("shell");
    expect(child.exitCode).toBeNull();
  });

  it("resolves the Caddy try_files rule: {path}, {path}.html, /index.html", async () => {
    const exact = await fetch(`${base}/index.html`);
    expect(await exact.text()).toContain("shell");

    const html = await fetch(`${base}/page`); // page → page.html
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("page");

    const dirIndex = await fetch(`${base}/nested`); // directory → its index.html
    expect(await dirIndex.text()).toContain("nested");

    const fallback = await fetch(`${base}/no/such/route`); // shell fallback
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("shell");
  });

  it("refuses encoded traversal outside the export directory", async () => {
    const res = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
  });
});
