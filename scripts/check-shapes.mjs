#!/usr/bin/env node
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Hash-pin guard for the vendored SHACL shapes (ADR-0014 Phase 1).
 *
 * Recomputes the sha256 of every shape listed in
 * `src/lib/shacl/shapes-lock.json` and fails (exit 1) if any file's hash drifts
 * from the pinned value, or if a pinned file is missing, or a shape file exists
 * on disk that the lock does not pin. This makes a vendored shape impossible to
 * change silently — a drift is a deliberate, reviewable lock bump.
 *
 * Run via `npm run check:shapes` (wired into the gate).
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHACL_DIR = join(HERE, "..", "src", "lib", "shacl");
const LOCK_PATH = join(SHACL_DIR, "shapes-lock.json");
const SHAPES_DIR = join(SHACL_DIR, "shapes");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  if (lock.algorithm !== "sha256") {
    console.error(`check:shapes — unsupported algorithm "${lock.algorithm}" (expected sha256)`);
    process.exit(1);
  }

  const errors = [];
  const pinned = new Set(Object.keys(lock.shapes));

  // 1. Every pinned shape must exist and match its hash.
  for (const [rel, entry] of Object.entries(lock.shapes)) {
    const abs = join(SHACL_DIR, rel);
    let actual;
    try {
      actual = sha256(abs);
    } catch {
      errors.push(`MISSING: pinned shape "${rel}" is not on disk`);
      continue;
    }
    if (actual !== entry.sha256) {
      errors.push(
        `DRIFT: "${rel}"\n   expected ${entry.sha256}\n   actual   ${actual}\n   ` +
          `→ a vendored shape changed. If intentional, re-vendor from ${entry.source?.repo ?? "source"} ` +
          `and bump shapes-lock.json in the SAME commit.`,
      );
    }
  }

  // 2. Every .ttl on disk must be pinned (no un-tracked shape sneaking in).
  let onDisk = [];
  try {
    onDisk = readdirSync(SHAPES_DIR).filter((f) => f.endsWith(".ttl"));
  } catch {
    errors.push(`MISSING: shapes directory ${SHAPES_DIR} not found`);
  }
  for (const f of onDisk) {
    const rel = `shapes/${f}`;
    if (!pinned.has(rel)) {
      errors.push(`UNPINNED: shape "${rel}" exists on disk but is not in shapes-lock.json`);
    }
  }

  if (errors.length > 0) {
    console.error("check:shapes FAILED:\n\n" + errors.join("\n\n"));
    process.exit(1);
  }
  console.log(`check:shapes OK — ${pinned.size} vendored shape(s) match shapes-lock.json`);
}

main();
