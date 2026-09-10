// install-claude-plugin.test.mjs — the INTERACTIVE path. Two halves:
//
//  1. dist/install-claude.js itself stays self-contained (INTERFACE.md §15) and never installs a
//     Claude Code plugin: handed wicked-garden it reports a manual step and writes nothing (no
//     staging, no skills/ copy, no hooks in settings.json, no marker entry). Its marker-driven
//     `uninstall` refuses recorded paths that escape the config dir or the roots it writes.
//  2. The central picker (dispatchToClis in dist/index.js) hands the script the product list
//     WITHOUT garden, registers garden through the shared mechanism, and only after that succeeds
//     removes a legacy skills/hooks copy — through the script's own `uninstall`. On a failed
//     registration the config dir is left byte-identical.
//
// Sandboxed like garden-registration.test.mjs: the Claude Code CLI is tests/claude-stub.mjs via
// WICKED_CLAUDE_BIN, HOME is a temp dir, npm/npx on PATH are logging shell fakes, and --source-root
// points at a temp root holding a wicked-vault package.json so the script stages vault locally (no
// `npm pack`). The dispatcher half mutates process.env in-process, so this file must not share a
// process with other suites (node --test runs each file in its own). POSIX fakes ⇒ skipped on Windows.
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "dist", "install-claude.js");
const STUB = join(__dirname, "claude-stub.mjs");
const POSIX = process.platform !== "win32";
const skip = POSIX ? false : "PATH fakes are POSIX shell scripts";

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-install-claude-"));
  const home = join(tmp, "home");
  const cfg = join(tmp, "cfg");
  const srcRoot = join(tmp, "checkouts");
  const bin = join(tmp, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(srcRoot, "wicked-vault"), { recursive: true });
  writeFileSync(join(srcRoot, "wicked-vault", "package.json"), JSON.stringify({ name: "wicked-vault", version: "0.0.0-test" }));
  if (POSIX) {
    for (const name of ["npm", "npx"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$FAKE_NPM_LOG"\nexit 0\n`, { mode: 0o755 });
    }
  }
  return { tmp, home, cfg, srcRoot, bin, stubLog: join(tmp, "claude-stub.log"), npmLog: join(tmp, "npm.log") };
}

function runScript(sb, args, { claude = true, env: extra = {} } = {}) {
  const env = { PATH: dirname(process.execPath), HOME: sb.home, USERPROFILE: sb.home, CLAUDE_STUB_LOG: sb.stubLog, ...extra };
  if (claude) env.WICKED_CLAUDE_BIN = STUB;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 120_000 });
}

const stubCalls = (sb) => (existsSync(sb.stubLog) ? readFileSync(sb.stubLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.configDir, c.argv.join(" ")]) : []);
const lines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const cleanup = (sb) => rmSync(sb.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const markerPath = (cfg) => join(cfg, "wicked-installer", "claude-install.json");
const marker = (cfg) => JSON.parse(readFileSync(markerPath(cfg), "utf8"));
const cacheDir = (cfg, version = "0.0.1-stub") => join(cfg, "plugins", "cache", "wicked-garden", "wicked-garden", version);

function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      out.push(relative(dir, f) + (e.isDirectory() ? "/" : `:${statSync(f).size}:${readFileSync(f).toString("base64").slice(0, 64)}`));
      if (e.isDirectory()) walk(f);
    }
  })(dir);
  return out.sort();
}

/** No plugin footprint in a config dir: nothing in skills/, no hooks, no .claude.json, no hooks payload. */
function assertNoLegacyWrites(cfg) {
  const skills = join(cfg, "skills");
  if (existsSync(skills)) assert.deepEqual(readdirSync(skills), [], "no skills copied into the config dir");
  if (existsSync(join(cfg, "settings.json"))) {
    assert.equal(JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")).hooks, undefined, "no hooks wired into settings.json");
  }
  assert.ok(!existsSync(join(cfg, ".claude.json")), "no .claude.json written");
  assert.ok(!existsSync(join(cfg, "wicked-installer", "products", "wicked-garden")), "no hooks payload copied");
}

/** A legacy install-claude.js footprint: a copied skill dir recorded in a v2 marker. */
function plantLegacyCopy(cfg) {
  mkdirSync(join(cfg, "skills", "wicked-garden-core"), { recursive: true });
  writeFileSync(join(cfg, "skills", "wicked-garden-core", "SKILL.md"), "---\nname: wicked-garden-core\n---\nwicked-garden\n");
  mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
  writeFileSync(markerPath(cfg), JSON.stringify({
    markerVersion: 2,
    cli: "claude",
    configDir: cfg,
    updatedAt: "2026-01-01T00:00:00.000Z",
    products: {
      "wicked-garden": { installedAt: "2026-01-01T00:00:00.000Z", lastResult: "installed", version: "12.0.0", source: "npm-pack", files: [{ kind: "dir", path: "skills/wicked-garden-core" }], notes: [] },
    },
  }));
}

// ---------------------------------------------------------------------------
// 1. The script itself
// ---------------------------------------------------------------------------

test("install-claude.js imports nothing from src/ (INTERFACE.md §15 self-contained)", () => {
  const src = readFileSync(join(ROOT, "src", "install-claude.ts"), "utf8");
  const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const spec of imports) assert.match(spec, /^node:/, `install-claude.ts must import only node: builtins, found ${spec}`);
});

test("install-claude.js handed wicked-garden: a manual step, nothing staged/copied/wired, no marker entry", () => {
  const sb = sandbox();
  try {
    const r = runScript(sb, ["wicked-garden", "--claude-home", sb.cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    const garden = report.reports.find((x) => x.productId === "wicked-garden");
    assert.equal(garden.success, true);
    assert.equal(garden.skipped, true, "a plugin is a manual step for this script");
    assert.match(garden.message, /Claude Code plugin — registered by the central installer, not copied by this script/);
    assert.ok(garden.notes.some((n) => /npx wicked-installer install wicked-garden/.test(n)), JSON.stringify(garden.notes));
    assert.deepEqual(garden.actions, []);
    assert.ok(!existsSync(sb.stubLog), "the script never invokes claude");
    assertNoLegacyWrites(sb.cfg);
    assert.ok(!("wicked-garden" in marker(sb.cfg).products), "no marker entry claims an install");
    assert.ok(marker(sb.cfg).products["wicked-vault"], "the dependency still went through the normal path");

    const dry = runScript(sb, ["wicked-garden", "--claude-home", join(sb.tmp, "cfg-dry"), "--source-root", sb.srcRoot, "--skip-binaries", "--json", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal(JSON.parse(dry.stdout).reports.find((x) => x.productId === "wicked-garden").skipped, true);
    assert.ok(!existsSync(join(sb.tmp, "cfg-dry")));
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js uninstall refuses marker paths that escape the config dir or the roots it writes", () => {
  const sb = sandbox();
  const outside = join(sb.tmp, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "must survive");
  mkdirSync(join(sb.cfg, "skills", "wicked-garden-core"), { recursive: true });
  writeFileSync(join(sb.cfg, "skills", "wicked-garden-core", "SKILL.md"), "---\nname: wicked-garden-core\n---\nwicked-garden\n");
  writeFileSync(join(sb.cfg, "settings.json"), JSON.stringify({ theme: "dark" }));
  mkdirSync(join(sb.cfg, "wicked-installer"), { recursive: true });
  writeFileSync(markerPath(sb.cfg), JSON.stringify({
    markerVersion: 2, cli: "claude", configDir: sb.cfg, updatedAt: "2026-01-01T00:00:00.000Z",
    products: {
      "wicked-garden": {
        installedAt: "2026-01-01T00:00:00.000Z", lastResult: "installed", notes: [],
        files: [
          { kind: "dir", path: "skills/wicked-garden-core" },          // legitimate
          { kind: "dir", path: "../outside" },                          // parent traversal
          { kind: "dir", path: outside },                               // absolute
          { kind: "file", path: "settings.json" },                      // not a discovery root
          { kind: "dir", path: "wicked-installer/products/other-product" }, // another product's payload
          { kind: "json-key", file: "../outside/keep.txt", pointer: "/x", wroteHash: "0" }, // not a config file this script writes
        ],
      },
    },
  }));
  try {
    const r = runScript(sb, ["uninstall", "wicked-garden", "--claude-home", sb.cfg, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const garden = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-garden");
    const byTarget = Object.fromEntries(garden.actions.map((a) => [a.target, a]));
    assert.deepEqual(byTarget["skills/wicked-garden-core"], { kind: "remove", target: "skills/wicked-garden-core", result: "ok" });
    assert.match(byTarget["../outside"].detail, /refused: absolute, home-relative or parent-traversing path/);
    assert.match(byTarget[outside].detail, /refused: absolute, home-relative or parent-traversing path/);
    assert.match(byTarget["settings.json"].detail, /refused: outside the discovery roots this script writes/);
    assert.match(byTarget["wicked-installer/products/other-product"].detail, /refused: outside the discovery roots this script writes/);
    assert.match(byTarget["../outside/keep.txt/x"].detail, /refused: not a config file this script writes/);
    assert.ok(!existsSync(join(sb.cfg, "skills", "wicked-garden-core")), "the legitimate path was removed");
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "must survive", "nothing outside the config dir was touched");
    assert.deepEqual(JSON.parse(readFileSync(join(sb.cfg, "settings.json"), "utf8")), { theme: "dark" }, "settings.json untouched");
  } finally {
    cleanup(sb);
  }
});

// ---------------------------------------------------------------------------
// 2. The central picker's Claude dispatch
// ---------------------------------------------------------------------------

const indexModule = await import(join(ROOT, "dist", "index.js"));
const cliOption = { cli: "claude", displayName: "Claude Code", scriptPath: SCRIPT, detected: true, binOnPath: true, homeDetected: true };

/** Run dispatchToClis in-process with the sandbox env, capturing console output. */
async function dispatch(sb, productIds, flags, { claude = true, env: extra = {} } = {}) {
  const saved = { ...process.env };
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  for (const k of ["WICKED_CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "CLAUDE_STUB_FAIL"]) delete process.env[k];
  Object.assign(process.env, {
    PATH: `${sb.bin}:${dirname(process.execPath)}`,
    HOME: sb.home,
    USERPROFILE: sb.home,
    CLAUDE_CONFIG_DIR: sb.cfg,
    CLAUDE_STUB_LOG: sb.stubLog,
    FAKE_NPM_LOG: sb.npmLog,
    WICKED_SOURCE_ROOT: sb.srcRoot,
    ...extra,
  });
  if (claude) process.env.WICKED_CLAUDE_BIN = STUB;
  try {
    const code = await indexModule.dispatchToClis([cliOption], productIds, { dryRun: false, force: false, claudeHomes: [], ...flags });
    return { code, out: logs.join("\n") };
  } finally {
    console.log = origLog;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("dispatch: the Claude script gets the products WITHOUT garden; garden is registered through the shared mechanism; a legacy copy is removed only afterwards", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyCopy(sb.cfg);
  try {
    const { code, out } = await dispatch(sb, ["wicked-vault", "wicked-garden"], {});
    assert.equal(code, 0, out);
    // The script installed vault (binary skipped? no: first CLI acquires) …
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault"], "vault acquired once, garden's install.mjs never run");
    // … garden went through the registration path, pinned to the sandbox config dir …
    assert.deepEqual(stubCalls(sb), [
      [sb.cfg, "--version"],
      [sb.cfg, "plugin marketplace add mikeparcewski/wicked-garden"],
      [sb.cfg, "plugin install wicked-garden@wicked-garden"],
    ]);
    assert.ok(existsSync(cacheDir(sb.cfg)), "payload where Claude Code loads from");
    // … and the legacy copy recorded by the earlier script install is gone, via the script's uninstall.
    assert.ok(!existsSync(join(sb.cfg, "skills", "wicked-garden-core")), "legacy skills copy removed");
    assert.ok(!("wicked-garden" in marker(sb.cfg).products), "the marker no longer claims the legacy copy");
    assert.ok(marker(sb.cfg).products["wicked-vault"], "vault's marker entry from the script run is intact");
    assertNoLegacyWrites(sb.cfg);
    assert.match(out, /registered with Claude Code as wicked-garden@wicked-garden/);
    assert.match(out, /removed the legacy skills\/hooks copy recorded by an earlier install \(install-claude\.js uninstall\)/);
    assert.match(out, /Wicked Garden\s+ok/, "the summary grid shows garden ok under Claude Code");
  } finally {
    cleanup(sb);
  }
});

test("dispatch: a present-but-broken claude fails garden and leaves the prior install byte-identical", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyCopy(sb.cfg);
  const before = snapshot(sb.cfg);
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], {}, { env: { CLAUDE_STUB_FAIL: "version" } });
    assert.equal(code, 1, out);
    assert.match(out, /--version failed \(exit 1\): stub: claude is broken/);
    assert.deepEqual(snapshot(sb.cfg), before, "nothing in the config dir changed — no legacy removal, no registration");
    assert.deepEqual(lines(sb.npmLog), [], "no npx fallback either");
    assert.deepEqual(stubCalls(sb).map(([, a]) => a), ["--version"], "only the probe ran");
    assert.match(out, /Wicked Garden\s+failed/);
  } finally {
    cleanup(sb);
  }
});

test("dispatch --dry-run: plan only — nothing written, legacy removal reported as planned", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyCopy(sb.cfg);
  const before = snapshot(sb.cfg);
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], { dryRun: true });
    assert.equal(code, 0, out);
    assert.deepEqual(snapshot(sb.cfg), before, "a dry run writes nothing");
    assert.match(out, /dry-run:\s+CLAUDE_CONFIG_DIR=\S+ claude plugin install wicked-garden@wicked-garden/);
    assert.match(out, /would remove the legacy skills\/hooks copy recorded by an earlier install \(install-claude\.js uninstall --dry-run\)/);
    assert.deepEqual(stubCalls(sb).map(([, a]) => a), ["--version"], "a dry run spawns only the probe");
    assert.deepEqual(lines(sb.npmLog), []);
  } finally {
    cleanup(sb);
  }
});

test("dispatch: an invalid --source-root is rejected before the script runs or any dependency is acquired", { skip }, async () => {
  const sb = sandbox();
  const bogus = join(sb.tmp, "not-a-checkout");
  mkdirSync(bogus);
  try {
    const { code, out } = await dispatch(sb, ["wicked-vault", "wicked-garden"], { sourceRoot: bogus });
    assert.equal(code, 1, out);
    assert.match(out, /no \.claude-plugin\/marketplace\.json under/);
    assert.deepEqual(lines(sb.npmLog), [], "vault was not acquired");
    assert.ok(!existsSync(sb.stubLog), "claude never invoked");
    assert.ok(!existsSync(sb.cfg), "the script never ran, so no config dir was created");
  } finally {
    cleanup(sb);
  }
});

test("dispatch: with no legacy copy nothing is uninstalled, and a fresh config dir ends up registered", { skip }, async () => {
  const sb = sandbox();
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], {});
    assert.equal(code, 0, out);
    assert.ok(existsSync(cacheDir(sb.cfg)));
    assert.doesNotMatch(out, /legacy skills\/hooks copy/);
    assert.ok(!existsSync(markerPath(sb.cfg)), "the script never ran for garden alone, so no marker was created");
  } finally {
    cleanup(sb);
  }
});
