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

// `claude --version` in any launch shape: `claude --version`, `claude.cmd --version`, or
// `node <…claude-stub.mjs> --version` (the WICKED_CLAUDE_BIN seam).
function isAllowedProbe(cmd, args) {
  const argv = [String(cmd), ...args];
  if (argv[argv.length - 1] !== "--version" || argv.length > 3) return false;
  return argv.slice(0, -1).some((a) => /claude/i.test(a));
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
