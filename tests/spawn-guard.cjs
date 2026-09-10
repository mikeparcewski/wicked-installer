// spawn-guard.cjs — a `node --require` preload that makes ANY process spawn or network fetch
// fail loudly, except the one read-only probe a dry run is allowed: `claude --version`
// (verified to write nothing — it is how the installer tells "Claude Code present" from
// "absent" without guessing). Every child_process entry point and globalThis.fetch is
// replaced: an allowed call is recorded with `allowed: true` and passed through; anything
// else is recorded and throws, so a `--dry-run` that spawns something both fails its run
// and leaves the attempted argv in $SPAWN_GUARD_LOG.
//
// Builtin ES-module facades keep their own live bindings, so after patching the CommonJS
// exports we call module.syncBuiltinESMExports() — otherwise `import { spawn } from
// "node:child_process"` (what execa does) would still see the originals.
"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const log = process.env.SPAWN_GUARD_LOG;

function record(entry) {
  if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\n");
}

const basename = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
const CLAUDE_BINARIES = new Set(["claude", "claude.cmd", "claude.exe", "claude.bat"]);

// Exactly `claude --version`, in its two launch shapes — the executable's basename is matched
// exactly (never a substring, so `evil-claude` or `claude-writer.mjs` do not qualify):
//   <…/claude|claude.cmd|claude.exe|claude.bat> --version
//   <node> <…/claude-stub.mjs> --version            (the WICKED_CLAUDE_BIN test seam)
function isAllowedProbe(cmd, args) {
  if (args.length === 1 && args[0] === "--version" && CLAUDE_BINARIES.has(basename(cmd))) return true;
  if (args.length === 2 && args[1] === "--version" && String(cmd) === process.execPath && basename(args[0]) === "claude-stub.mjs") return true;
  return false;
}

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const orig = cp[name];
  cp[name] = function guarded(cmd, args, ...rest) {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (isAllowedProbe(cmd, argv)) {
      record({ kind: name, cmd: String(cmd), args: argv, allowed: true });
      return orig.call(this, cmd, args, ...rest);
    }
    const line = JSON.stringify({ kind: name, cmd: String(cmd), args: argv, allowed: false });
    record({ kind: name, cmd: String(cmd), args: argv, allowed: false });
    throw new Error(`spawn-guard: ${line}`);
  };
}
globalThis.fetch = async function guardedFetch(url) {
  record({ kind: "fetch", cmd: String(url), args: [], allowed: false });
  throw new Error(`spawn-guard: fetch ${String(url)}`);
};

syncBuiltinESMExports();
