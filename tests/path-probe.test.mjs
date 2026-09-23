// path-probe.test.mjs — "is this binary on PATH?" must not depend on how loaded the host is (#28).
//
// The old probe spawned `command -v <cmd>` with a 2 s timeout and returned false on ANY exception.
// At loadavg 133 every probe timed out (24/24), so `status` printed installed products as
// "not installed" and `detectClis` silently dropped CLIs that were present. A timeout is an
// inability to check, not a checked negative.
//
// The harness reproduces that host deterministically: a preload makes EVERY child_process entry
// point throw ETIMEDOUT (what execSync throws when its timeout fires). Detection that resolves
// binaries in-process is unaffected; detection that shells out reads everything as absent.
//
// Each scenario runs in a child node with PATH and HOME pointed at temp dirs, so nothing on the
// machine running the suite leaks into the answers. Every expected value is a literal.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const detectorUrl = "file://" + join(root, "dist", "detector.js");
const posix = process.platform !== "win32";

// Every subprocess API times out, the way execSync does when its budget is exceeded.
const TIMEOUT_EVERYTHING = `
"use strict";
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
function timedOut(name) {
  return function () {
    const err = new Error(name + " ETIMEDOUT (simulated host load)");
    err.code = "ETIMEDOUT";
    throw err;
  };
}
for (const name of ["execSync", "execFileSync", "spawnSync", "exec", "execFile", "spawn", "fork"]) {
  cp[name] = timedOut(name);
}
syncBuiltinESMExports();
`;

/** Make `name` in `dir` — an executable shell script unless `executable` is false. */
function makeBin(dir, name, { executable = true } = {}) {
  const file = join(dir, posix ? name : name + ".cmd");
  writeFileSync(file, posix ? "#!/bin/sh\nexit 0\n" : "@exit /b 0\r\n");
  if (posix) chmodSync(file, executable ? 0o755 : 0o644);
}

/**
 * Run detection in a child whose PATH is exactly `pathDir` and whose HOME is an empty temp dir.
 * Returns { clis: string[], products: {id: bool} }.
 */
function detect(pathDir, { loaded }) {
  const work = mkdtempSync(join(tmpdir(), "installer-probe-"));
  try {
    const preload = join(work, "timeout-everything.cjs");
    writeFileSync(preload, TIMEOUT_EVERYTHING);
    const home = join(work, "home");
    const script = `
      const d = await import(${JSON.stringify(detectorUrl)});
      const clis = d.detectClis().map((c) => c.id);
      const products = {};
      for (const id of ["wicked-bus", "wicked-estate"]) products[id] = d.isProductInstalled(id);
      process.stdout.write(JSON.stringify({ clis, products }));
    `;
    const args = [...(loaded ? ["--require", preload] : []), "--input-type=module", "-e", script];
    const env = { ...process.env, PATH: pathDir, Path: pathDir, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(r.status, 0, `detection child failed:\n${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("#28: binaries on PATH are detected even when every subprocess times out", () => {
  const bin = mkdtempSync(join(tmpdir(), "installer-path-"));
  try {
    for (const name of ["claude", "codex", "wicked-bus", "wicked-estate", "wicked-estate-mcp"]) makeBin(bin, name);
    const got = detect(bin, { loaded: true });
    assert.deepEqual(got.clis, ["claude-code", "codex"], "a CLI on PATH must not vanish because a probe timed out");
    assert.deepEqual(got.products, { "wicked-bus": true, "wicked-estate": true },
      "an installed product must not read 'not installed' because a probe timed out");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("#28: a binary absent from PATH is not detected", () => {
  const bin = mkdtempSync(join(tmpdir(), "installer-path-"));
  try {
    makeBin(bin, "wicked-estate"); // half of a two-crate product: still not installed
    for (const loaded of [false, true]) {
      const got = detect(bin, { loaded });
      assert.deepEqual(got.clis, [], `no CLI is on PATH (loaded=${loaded})`);
      assert.deepEqual(got.products, { "wicked-bus": false, "wicked-estate": false }, `loaded=${loaded}`);
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("#28: a non-executable file of the right name is not detected (posix)", { skip: !posix }, () => {
  const bin = mkdtempSync(join(tmpdir(), "installer-path-"));
  try {
    for (const name of ["claude", "wicked-bus"]) makeBin(bin, name, { executable: false });
    const got = detect(bin, { loaded: false });
    assert.deepEqual(got.clis, [], "a 0644 `claude` is not a runnable CLI");
    assert.deepEqual(got.products, { "wicked-bus": false, "wicked-estate": false });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("#28: a PATH dir that cannot be searched reads 'could not verify', never 'not installed'", {
  skip: !posix || process.getuid?.() === 0, // root can search a 0000 dir; the scenario needs a denial
}, () => {
  const work = mkdtempSync(join(tmpdir(), "installer-status-"));
  const locked = join(work, "locked");
  try {
    const home = join(work, "home");
    const env = { ...process.env, PATH: locked, HOME: home, USERPROFILE: home, NO_COLOR: "1", FORCE_COLOR: "0" };
    delete env.CLAUDE_CONFIG_DIR;
    // mkdir then remove every permission: stat(locked/<bin>) now fails EACCES — the probe
    // cannot tell whether the binary is there.
    spawnSync("mkdir", ["-p", locked, home]);
    makeBin(locked, "wicked-bus");
    makeBin(locked, "claude");
    chmodSync(locked, 0o000);
    const r = spawnSync(process.execPath, [join(root, "dist", "index.js"), "status"], { encoding: "utf8", env, timeout: 30_000 });
    const out = r.stdout;
    assert.match(out, /\? could not verify\s+wicked-bus\b/, `status must say it could not verify wicked-bus:\n${out}`);
    assert.doesNotMatch(out, /not installed\s+wicked-bus\b/, "an unverifiable probe must not render as 'not installed'");
    assert.match(out, /\? Claude Code \(could not verify: EACCES/, `an unverifiable CLI must be listed, not dropped:\n${out}`);
  } finally {
    try { chmodSync(locked, 0o755); } catch {}
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
