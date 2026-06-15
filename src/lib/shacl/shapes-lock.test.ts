// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", ".."); // src/lib/shacl → repo root
const CHECK_SCRIPT = join(REPO_ROOT, "scripts", "check-shapes.mjs");
const LOCK_PATH = join(HERE, "shapes-lock.json");
const SHAPE_PATH = join(HERE, "shapes", "issue.ttl");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("shapes-lock.json hash-pin", () => {
  it("the committed lock matches the vendored shape on disk (check:shapes passes)", () => {
    // The real, committed state must pass — the gate's invariant.
    expect(() => execFileSync("node", [CHECK_SCRIPT], { stdio: "pipe" })).not.toThrow();
  });

  it("the pinned sha256 equals the actual file hash", () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    expect(lock.shapes["shapes/issue.ttl"].sha256).toBe(sha256(SHAPE_PATH));
  });

  it("a drifted shape FAILS the guard (a vendored shape cannot change silently)", () => {
    // Copy the whole shacl dir + the script into a temp tree, mutate the shape,
    // and assert the guard exits non-zero. Mutating in place would dirty the
    // worktree, so we run an isolated copy.
    const tmp = mkdtempSync(join(tmpdir(), "shapes-drift-"));
    try {
      const scriptsDir = join(tmp, "scripts");
      const shaclDir = join(tmp, "src", "lib", "shacl");
      cpSync(join(REPO_ROOT, "scripts"), scriptsDir, { recursive: true });
      cpSync(HERE, shaclDir, { recursive: true });

      // Drift: append a byte to the vendored shape so its hash no longer matches.
      const driftedShape = join(shaclDir, "shapes", "issue.ttl");
      writeFileSync(driftedShape, readFileSync(driftedShape, "utf8") + "\n# tampered\n");

      let threw = false;
      let output = "";
      try {
        execFileSync("node", [join(scriptsDir, "check-shapes.mjs")], { stdio: "pipe" });
      } catch (e) {
        threw = true;
        output = String((e as { stderr?: Buffer }).stderr ?? "");
      }
      expect(threw).toBe(true);
      expect(output).toMatch(/DRIFT/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an UNPINNED extra shape FAILS the guard", () => {
    const tmp = mkdtempSync(join(tmpdir(), "shapes-unpinned-"));
    try {
      const scriptsDir = join(tmp, "scripts");
      const shaclDir = join(tmp, "src", "lib", "shacl");
      cpSync(join(REPO_ROOT, "scripts"), scriptsDir, { recursive: true });
      cpSync(HERE, shaclDir, { recursive: true });

      writeFileSync(join(shaclDir, "shapes", "rogue.ttl"), "# not pinned\n");

      let threw = false;
      let output = "";
      try {
        execFileSync("node", [join(scriptsDir, "check-shapes.mjs")], { stdio: "pipe" });
      } catch (e) {
        threw = true;
        output = String((e as { stderr?: Buffer }).stderr ?? "");
      }
      expect(threw).toBe(true);
      expect(output).toMatch(/UNPINNED/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
