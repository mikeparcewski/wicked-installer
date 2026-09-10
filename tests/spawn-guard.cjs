// spawn-guard.cjs — a `node --require` preload that makes ANY process spawn or network fetch
// fail loudly. Every child_process entry point and globalThis.fetch is replaced with a function
// that appends the attempted call to $SPAWN_GUARD_LOG and throws, so a `--dry-run` that spawns
// something both fails its run and leaves evidence of exactly what it tried to run.
//
// Builtin ES-module facades keep their own live bindings, so after patching the CommonJS exports
// we call module.syncBuiltinESMExports() — otherwise `import { spawn } from "node:child_process"`
// (what execa does) would still see the originals.
"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const log = process.env.SPAWN_GUARD_LOG;

function trip(kind, cmd, args) {
  const line = JSON.stringify({ kind, cmd: String(cmd), args: Array.isArray(args) ? args.map(String) : [] });
  if (log) fs.appendFileSync(log, line + "\n");
  throw new Error(`spawn-guard: ${line}`);
}

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cp[name] = function guarded(cmd, args) {
    return trip(name, cmd, args);
  };
}
globalThis.fetch = async function guardedFetch(url) {
  return trip("fetch", url, []);
};

syncBuiltinESMExports();
