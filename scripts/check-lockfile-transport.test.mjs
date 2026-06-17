// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Enforces the check:lockfile-transport guard as part of `vitest run` (the CI
// `unit` job), mirroring how shapes-lock.test.ts gates check:shapes:
//   1. the REAL committed lockfile must pass (the gate's invariant), and
//   2. a lockfile carrying an SSH git transport must FAIL the guard.
//
// This is the #78 bug class: `npm install` (npm 11.x / hosted-git-info) rewrites
// `@jeswr` github: deps' `resolved` URLs back to `git+ssh://git@github.com/...`,
// which `npm ci` can't resolve in CI / Vercel without an SSH key. The guard (and
// this test) stop a stray `npm install` from quietly re-breaking the lockfile.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SCRIPT = new URL("./check-lockfile-transport.mjs", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;

// Each case spawns a fresh `node` subprocess (a real run of the guard), which
// is slow under the full concurrent suite — give them a generous timeout, as
// scripts/serve-static.test.mjs does for its spawned server.
const SPAWN_TIMEOUT = 30_000;

describe("check:lockfile-transport guard", () => {
  it(
    "the real committed lockfile passes (no SSH git transport)",
    () => {
      // The actual repo state must be clean — run the guard with the repo as cwd.
      expect(() =>
        execFileSync("node", [SCRIPT], { cwd: REPO_ROOT, stdio: "pipe" }),
      ).not.toThrow();
    },
    SPAWN_TIMEOUT,
  );

  it("FAILS when a lockfile carries a git+ssh:// transport", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lockguard-ssh-"));
    try {
      cpSync(SCRIPT, join(tmp, "check-lockfile-transport.mjs"));
      writeFileSync(
        join(tmp, "package-lock.json"),
        JSON.stringify(
          {
            name: "x",
            lockfileVersion: 3,
            packages: {
              "node_modules/@jeswr/app-shell": {
                resolved: "git+ssh://git@github.com/jeswr/app-shell.git#deadbeef",
              },
            },
          },
          null,
          2,
        ),
      );
      let threw = false;
      let output = "";
      try {
        execFileSync("node", [join(tmp, "check-lockfile-transport.mjs")], {
          cwd: tmp,
          stdio: "pipe",
        });
      } catch (e) {
        threw = true;
        output = String(e.stderr ?? "");
      }
      expect(threw).toBe(true);
      expect(output).toMatch(/SSH git transport/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT);

  it("FAILS on the scp-like ssh://git@github form too", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lockguard-scp-"));
    try {
      cpSync(SCRIPT, join(tmp, "check-lockfile-transport.mjs"));
      writeFileSync(
        join(tmp, "package-lock.json"),
        JSON.stringify({
          name: "x",
          lockfileVersion: 3,
          packages: {
            "node_modules/@jeswr/solid-task-model": {
              resolved: "ssh://git@github.com/jeswr/solid-task-model.git#cafef00d",
            },
          },
        }),
      );
      let threw = false;
      try {
        execFileSync("node", [join(tmp, "check-lockfile-transport.mjs")], {
          cwd: tmp,
          stdio: "pipe",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT);

  it("PASSES a clean git+https lockfile (incl. nested dirs)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lockguard-ok-"));
    try {
      cpSync(SCRIPT, join(tmp, "check-lockfile-transport.mjs"));
      const ok = JSON.stringify({
        name: "x",
        lockfileVersion: 3,
        packages: {
          "node_modules/@jeswr/app-shell": {
            resolved: "git+https://github.com/jeswr/app-shell.git#deadbeef",
          },
        },
      });
      writeFileSync(join(tmp, "package-lock.json"), ok);
      mkdirSync(join(tmp, "web"));
      writeFileSync(join(tmp, "web", "package-lock.json"), ok);
      expect(() =>
        execFileSync("node", [join(tmp, "check-lockfile-transport.mjs")], {
          cwd: tmp,
          stdio: "pipe",
        }),
      ).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT);
});
