// install-claude-plugin.test.mjs — the INTERACTIVE path. Two halves:
//
//  1. dist/install-claude.js itself stays self-contained (INTERFACE.md §15) and never installs a
//     Claude Code plugin: handed wicked-garden it reports a manual step and writes nothing (no
//     staging, no skills/ copy, no hooks in settings.json, no marker entry); its `status` does not
//     report plugins at all; its `uninstall` names Claude Code's own `claude plugin uninstall`.
//  2. The central picker (dispatchToClis in dist/index.js) hands the script the product list
//     WITHOUT garden and registers garden through the shared mechanism. Legacy copies an earlier
//     installer left behind (a bare plugins/wicked-garden, or a skills copy recorded in the script's
//     marker) are DETECTED and REPORTED — never removed (their removal is issue #20). On a failed
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
const ISSUE = "https://github.com/mikeparcewski/wicked-installer/issues/20";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Content-hashed listing of a tree, to prove byte-identity. */
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
function plantLegacyMarkerCopy(cfg) {
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

/** A legacy `npx wicked-garden install` bare copy. */
function plantBareCopy(cfg) {
  mkdirSync(join(cfg, "plugins", "wicked-garden", ".claude-plugin"), { recursive: true });
  writeFileSync(join(cfg, "plugins", "wicked-garden", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "12.0.0" }));
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
    const garden = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-garden");
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

test("install-claude.js status does not report plugins, even when a legacy marker entry exists", () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyMarkerCopy(sb.cfg);
  try {
    const r = runScript(sb, ["status", "--all", "--claude-home", sb.cfg, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.ok(!report.reports.some((x) => x.productId === "wicked-garden"), "the script owns no plugin state to report");
    const explicit = runScript(sb, ["status", "wicked-garden", "--claude-home", sb.cfg, "--json"]);
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout).reports, [], "asking for the plugin by name yields no marker-derived line either");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js uninstall of a plugin names Claude Code's own `claude plugin uninstall`, with or without a legacy marker", () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyMarkerCopy(sb.cfg);
  try {
    const r = runScript(sb, ["uninstall", "wicked-garden", "--claude-home", sb.cfg, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const garden = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.ok(garden.notes.some((n) => /removed only the legacy skills\/hooks copy it had recorded.*claude plugin uninstall wicked-garden@wicked-garden/.test(n)), JSON.stringify(garden.notes));

    const fresh = join(sb.tmp, "cfg-fresh");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "settings.json"), "{}");
    const r2 = runScript(sb, ["uninstall", "wicked-garden", "--claude-home", fresh, "--json"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    const garden2 = JSON.parse(r2.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.match(garden2.message, /not installed$/);
    assert.ok(garden2.notes.some((n) => /recorded no legacy copy to remove.*claude plugin uninstall wicked-garden@wicked-garden/.test(n)), JSON.stringify(garden2.notes));
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

test("dispatch: the Claude script gets the products WITHOUT garden; garden is registered through the shared mechanism; legacy copies are reported and left in place", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyMarkerCopy(sb.cfg);
  plantBareCopy(sb.cfg);
  const legacyBefore = {
    skill: readFileSync(join(sb.cfg, "skills", "wicked-garden-core", "SKILL.md"), "utf8"),
    marker: readFileSync(markerPath(sb.cfg), "utf8"),
    bare: readFileSync(join(sb.cfg, "plugins", "wicked-garden", ".claude-plugin", "plugin.json"), "utf8"),
  };
  try {
    const { code, out } = await dispatch(sb, ["wicked-vault", "wicked-garden"], {});
    assert.equal(code, 0, out);
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault"], "vault acquired by the script once; garden's install.mjs never run");
    assert.deepEqual(stubCalls(sb), [
      [sb.cfg, "--version"],
      [sb.cfg, "plugin marketplace add mikeparcewski/wicked-garden"],
      [sb.cfg, "plugin install wicked-garden@wicked-garden"],
    ]);
    assert.ok(existsSync(cacheDir(sb.cfg)), "payload where Claude Code loads from");
    assert.match(out, /registered with Claude Code as wicked-garden@wicked-garden/);
    assert.match(out, /Wicked Garden\s+ok/, "the summary grid shows garden ok under Claude Code");

    // Legacy copies: reported, one line each, and left exactly as they were.
    assert.match(out, new RegExp(`legacy wicked-garden copy detected at ${escapeRe(join(sb.cfg, "plugins", "wicked-garden"))} — left in place; removal will ship separately \\(see ${escapeRe(ISSUE)}\\)`));
    assert.match(out, new RegExp(`legacy wicked-garden copy detected at ${escapeRe(markerPath(sb.cfg))} \\(install-claude\\.js marker: 1 recorded path\\(s\\)\\) — left in place; removal will ship separately \\(see ${escapeRe(ISSUE)}\\)`));
    assert.match(out, /2 legacy copies left in place/);
    assert.equal(readFileSync(join(sb.cfg, "skills", "wicked-garden-core", "SKILL.md"), "utf8"), legacyBefore.skill, "legacy skill copy untouched");
    assert.equal(readFileSync(join(sb.cfg, "plugins", "wicked-garden", ".claude-plugin", "plugin.json"), "utf8"), legacyBefore.bare, "bare copy untouched");
    const m = marker(sb.cfg);
    assert.deepEqual(m.products["wicked-garden"], JSON.parse(legacyBefore.marker).products["wicked-garden"], "the legacy marker entry is preserved");
    assert.ok(m.products["wicked-vault"], "the script's own vault entry was added alongside");
    assert.ok(!existsSync(join(sb.cfg, "wicked-installer", "products", "wicked-garden")), "nothing new was copied for garden");
  } finally {
    cleanup(sb);
  }
});

test("dispatch: a present-but-broken claude fails garden and leaves the config dir byte-identical", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyMarkerCopy(sb.cfg);
  plantBareCopy(sb.cfg);
  const before = snapshot(sb.cfg);
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], {}, { env: { CLAUDE_STUB_FAIL: "version" } });
    assert.equal(code, 1, out);
    assert.match(out, /--version failed \(exit 1\): stub: claude is broken/);
    assert.deepEqual(snapshot(sb.cfg), before, "nothing in the config dir changed");
    assert.deepEqual(lines(sb.npmLog), [], "no npx fallback either");
    assert.deepEqual(stubCalls(sb).map(([, a]) => a), ["--version"], "only the probe ran");
    assert.match(out, /Wicked Garden\s+failed/);
  } finally {
    cleanup(sb);
  }
});

test("dispatch: a failed install after this run's marketplace add is rolled back, and the config dir holds no half-registration", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], {}, { env: { CLAUDE_STUB_FAIL: "install" } });
    assert.equal(code, 1, out);
    assert.deepEqual(stubCalls(sb).map(([, a]) => a), ["--version", "plugin marketplace add mikeparcewski/wicked-garden", "plugin install wicked-garden@wicked-garden", "plugin marketplace remove wicked-garden"]);
    assert.match(out, /rolled back this run's marketplace add/);
    const known = JSON.parse(readFileSync(join(sb.cfg, "plugins", "known_marketplaces.json"), "utf8"));
    assert.ok(!("wicked-garden" in known));
    assert.ok(!existsSync(cacheDir(sb.cfg)));
  } finally {
    cleanup(sb);
  }
});

test("dispatch --dry-run: plan only — nothing written, legacy copies reported as left in place", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyMarkerCopy(sb.cfg);
  const before = snapshot(sb.cfg);
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], { dryRun: true });
    assert.equal(code, 0, out);
    assert.deepEqual(snapshot(sb.cfg), before, "a dry run writes nothing");
    assert.match(out, /dry-run:\s+CLAUDE_CONFIG_DIR=\S+ claude plugin install wicked-garden@wicked-garden/);
    assert.match(out, /if the install then fails: CLAUDE_CONFIG_DIR=\S+ claude plugin marketplace remove wicked-garden\s+\(rolls back this run's marketplace add\)/);
    assert.match(out, new RegExp(`legacy wicked-garden copy detected at ${escapeRe(markerPath(sb.cfg))} .* — left in place`));
    assert.deepEqual(stubCalls(sb).map(([, a]) => a), ["--version"], "a dry run spawns only the probe");
    assert.deepEqual(lines(sb.npmLog), []);
  } finally {
    cleanup(sb);
  }
});

test("dispatch: Claude selected but no `claude` CLI at all → a manual step, never the bare-copy fallback", { skip }, async () => {
  // A config home can make Claude Code selectable while the binary is absent (home-only detection).
  const sb = sandbox();
  mkdirSync(sb.cfg);
  writeFileSync(join(sb.cfg, "settings.json"), "{}");
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], {}, { claude: false });
    assert.equal(code, 0, out);
    assert.match(out, /Claude Code CLI not detected — manual step: install Claude Code, then re-run to register wicked-garden@wicked-garden; nothing was copied/);
    assert.match(out, /Wicked Garden\s+manual/, "the grid shows a manual step, not ok");
    assert.deepEqual(lines(sb.npmLog), [], "npx wicked-garden install was NOT run");
    assert.ok(!existsSync(join(sb.home, ".claude", "plugins", "wicked-garden")), "no bare copy");
    assert.ok(!existsSync(sb.stubLog));

    const dry = await dispatch(sb, ["wicked-garden"], { dryRun: true }, { claude: false });
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /would be a manual step: install Claude Code, then re-run to register wicked-garden@wicked-garden; nothing would be copied/);
    assert.doesNotMatch(dry.out, /npx wicked-garden install/);
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

test("dispatch: with no legacy copy nothing is reported as legacy, and a fresh config dir ends up registered", { skip }, async () => {
  const sb = sandbox();
  try {
    const { code, out } = await dispatch(sb, ["wicked-garden"], {});
    assert.equal(code, 0, out);
    assert.ok(existsSync(cacheDir(sb.cfg)));
    assert.doesNotMatch(out, /legacy wicked-garden copy/);
    assert.ok(!existsSync(markerPath(sb.cfg)), "the script never ran for garden alone, so no marker was created");
  } finally {
    cleanup(sb);
  }
});
