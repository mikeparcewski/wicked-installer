// install-claude-plugin.test.mjs — the INTERACTIVE path: dist/install-claude.js (the per-CLI script the
// central picker dispatches to) must install wicked-garden the same way the direct path does — by
// REGISTERING it through Claude Code's plugin CLI — and must not fall back to its legacy garden branch
// (staging the npm package, copying skills/ into the config dir, wiring hooks into settings.json).
//
// Sandboxed like garden-registration.test.mjs: the Claude Code CLI is tests/claude-stub.mjs via
// WICKED_CLAUDE_BIN, HOME is a temp dir, and --source-root points at a temp checkout root holding a
// wicked-garden marketplace manifest plus a wicked-vault package.json so the script stages vault
// locally (no `npm pack`) — with --skip-binaries so no `npm install -g` runs either.
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "dist", "install-claude.js");
const STUB = join(__dirname, "claude-stub.mjs");

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-install-claude-"));
  const home = join(tmp, "home");
  const cfg = join(tmp, "cfg");
  const srcRoot = join(tmp, "checkouts");
  mkdirSync(home);
  mkdirSync(join(srcRoot, "wicked-garden", ".claude-plugin"), { recursive: true });
  writeFileSync(join(srcRoot, "wicked-garden", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "wicked-garden", plugins: [{ name: "wicked-garden", source: "./" }] }));
  mkdirSync(join(srcRoot, "wicked-vault"));
  writeFileSync(join(srcRoot, "wicked-vault", "package.json"), JSON.stringify({ name: "wicked-vault", version: "0.0.0-test" }));
  return { tmp, home, cfg, srcRoot, stubLog: join(tmp, "claude-stub.log") };
}

function runScript(sb, args, { claude = true, env: extra = {} } = {}) {
  const env = {
    PATH: dirname(process.execPath),
    HOME: sb.home,
    USERPROFILE: sb.home,
    CLAUDE_STUB_LOG: sb.stubLog,
    ...extra,
  };
  if (claude) env.WICKED_CLAUDE_BIN = STUB;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 120_000 });
}

const calls = (sb) => (existsSync(sb.stubLog) ? readFileSync(sb.stubLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.configDir, c.argv.join(" ")]) : []);
const cleanup = (sb) => rmSync(sb.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const marker = (cfg) => JSON.parse(readFileSync(join(cfg, "wicked-installer", "claude-install.json"), "utf8"));
const baseArgs = (sb) => ["wicked-garden", "--claude-home", sb.cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"];

/** No legacy garden footprint: nothing in skills/, no hooks in settings.json, no .claude.json. */
function assertNoLegacyWrites(cfg) {
  const skills = join(cfg, "skills");
  if (existsSync(skills)) assert.deepEqual(readdirSync(skills), [], "no skills copied into the config dir");
  if (existsSync(join(cfg, "settings.json"))) {
    const settings = JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8"));
    assert.equal(settings.hooks, undefined, "no hooks wired into settings.json");
  }
  assert.ok(!existsSync(join(cfg, ".claude.json")), "no .claude.json written");
  assert.ok(!existsSync(join(cfg, "wicked-installer", "products", "wicked-garden")), "no hooks payload copied");
}

test("install-claude.js registers wicked-garden through Claude Code's CLI and writes no legacy CLI config", () => {
  const sb = sandbox();
  try {
    const r = runScript(sb, baseArgs(sb));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout); // pure JSON: Claude Code's own output is captured under --json
    assert.equal(report.verb, "install");
    assert.deepEqual(report.configDirs, [sb.cfg]);
    const garden = report.reports.find((x) => x.productId === "wicked-garden");
    assert.equal(garden.success, true);
    assert.equal(garden.skipped, false);
    assert.equal(garden.version, "0.0.1-stub");
    assert.match(garden.message, /registered with Claude Code \(wicked-garden@wicked-garden 0\.0\.1-stub\)/);
    assert.deepEqual(garden.assets, { skills: 0, agents: 0, commands: 0, mcp: 0, hooks: 0 });
    assert.deepEqual(garden.actions.map((a) => [a.kind, a.target, a.result]), [
      ["acquire", "wicked-garden@wicked-garden", "ok"],
      ["acquire", "wicked-garden@wicked-garden", "ok"],
    ]);
    assert.match(garden.actions[0].detail, new RegExp(`^CLAUDE_CONFIG_DIR=.* claude plugin marketplace add ${join(sb.srcRoot, "wicked-garden").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    assert.match(garden.actions[1].detail, /claude plugin install wicked-garden@wicked-garden$/);
    assert.ok(garden.notes.some((n) => /no skills\/, settings\.json or \.claude\.json writes/.test(n)), JSON.stringify(garden.notes));

    assert.deepEqual(calls(sb), [
      [sb.cfg, "--version"],
      [sb.cfg, `plugin marketplace add ${join(sb.srcRoot, "wicked-garden")}`],
      [sb.cfg, "plugin install wicked-garden@wicked-garden"],
    ]);
    assert.ok(existsSync(join(sb.cfg, "plugins", "cache", "wicked-garden", "wicked-garden", "0.0.1-stub")), "payload where Claude Code loads from");
    assertNoLegacyWrites(sb.cfg);

    // The marker records the product with NO owned files (the registration belongs to Claude Code).
    const m = marker(sb.cfg);
    assert.deepEqual(m.products["wicked-garden"].files, []);
    assert.equal(m.products["wicked-garden"].version, "0.0.1-stub");
    assert.equal(m.products["wicked-garden"].lastResult, "installed");
    assert.ok(m.products["wicked-garden"].notes.some((n) => /registered with Claude Code/.test(n)));
    // The dependency still went through the normal (local-staged) path.
    assert.ok(m.products["wicked-vault"], "vault has its own marker entry");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js --dry-run --json: pure JSON, planned actions, only the --version probe spawned, nothing created", () => {
  const sb = sandbox();
  try {
    const r = runScript(sb, [...baseArgs(sb), "--dry-run"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.dryRun, true);
    const garden = report.reports.find((x) => x.productId === "wicked-garden");
    assert.equal(garden.success, true);
    assert.match(garden.message, /would register with Claude Code/);
    assert.deepEqual(garden.actions.map((a) => [a.kind, a.result]), [["acquire", "planned"], ["acquire", "planned"]]);
    assert.match(garden.actions[0].detail, /claude plugin marketplace add /);
    assert.match(garden.actions[1].detail, /claude plugin install wicked-garden@wicked-garden$/);
    assert.deepEqual(calls(sb).map(([, argv]) => argv), ["--version"], "a dry run probes and runs nothing else");
    assert.ok(!existsSync(sb.cfg), "a dry run creates no config dir");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js migrates a prior skills copy: the marker-recorded files are removed, then the plugin is registered", () => {
  const sb = sandbox();
  try {
    // What an earlier version of this script left behind: a copied skill dir, recorded in the marker.
    mkdirSync(join(sb.cfg, "skills", "wicked-garden-core"), { recursive: true });
    writeFileSync(join(sb.cfg, "skills", "wicked-garden-core", "SKILL.md"), "---\nname: wicked-garden-core\n---\nwicked-garden\n");
    mkdirSync(join(sb.cfg, "wicked-installer"), { recursive: true });
    writeFileSync(join(sb.cfg, "wicked-installer", "claude-install.json"), JSON.stringify({
      markerVersion: 2,
      cli: "claude",
      configDir: sb.cfg,
      updatedAt: "2026-01-01T00:00:00.000Z",
      products: {
        "wicked-garden": { installedAt: "2026-01-01T00:00:00.000Z", lastResult: "installed", version: "12.0.0", source: "npm-pack", files: [{ kind: "dir", path: "skills/wicked-garden-core" }], notes: [] },
      },
    }));
    const r = runScript(sb, baseArgs(sb));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const garden = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.equal(garden.success, true);
    assert.deepEqual(garden.actions[0], { kind: "remove", target: "skills/wicked-garden-core", result: "ok" });
    assert.ok(garden.notes.some((n) => /removed the legacy skills\/hooks copy \(1 recorded path\(s\)\)/.test(n)), JSON.stringify(garden.notes));
    assert.ok(!existsSync(join(sb.cfg, "skills", "wicked-garden-core")), "the legacy copy is gone");
    assertNoLegacyWrites(sb.cfg);
    assert.deepEqual(marker(sb.cfg).products["wicked-garden"].files, []);
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js without Claude Code: a manual step, not a bare copy — nothing staged or copied", () => {
  const sb = sandbox();
  try {
    const r = runScript(sb, baseArgs(sb), { claude: false });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const garden = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.equal(garden.success, true);
    assert.equal(garden.skipped, true, "reported as a manual step");
    assert.match(garden.message, /Claude Code CLI not detected/);
    assert.ok(garden.notes.some((n) => /install Claude Code and re-run/.test(n)));
    assert.deepEqual(garden.actions, []);
    assert.ok(!existsSync(sb.stubLog));
    assertNoLegacyWrites(sb.cfg);
    assert.ok(!("wicked-garden" in marker(sb.cfg).products), "no marker entry claims an install");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js status: a registered plugin reads current; one whose payload vanished reads stale", () => {
  const sb = sandbox();
  try {
    assert.equal(runScript(sb, baseArgs(sb)).status, 0);
    let s = runScript(sb, ["status", "wicked-garden", "--claude-home", sb.cfg, "--json"]);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    let garden = JSON.parse(s.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.ok(garden.notes.some((n) => /plugin registration registered$/.test(n)), JSON.stringify(garden.notes));
    assert.ok(garden.notes.some((n) => /: current \(version 0\.0\.1-stub\)/.test(n)));

    rmSync(join(sb.cfg, "plugins", "cache"), { recursive: true, force: true });
    s = runScript(sb, ["status", "wicked-garden", "--claude-home", sb.cfg, "--json"]);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    garden = JSON.parse(s.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.ok(garden.notes.some((n) => /plugin registration partially registered \(payload dir missing/.test(n)), JSON.stringify(garden.notes));
    assert.ok(garden.notes.some((n) => /: stale \(version 0\.0\.1-stub\)/.test(n)));
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js: an invalid explicit --source-root fails BEFORE any config dir or marker is created", () => {
  const sb = sandbox();
  const bogus = join(sb.tmp, "not-a-checkout");
  mkdirSync(bogus);
  try {
    const r = runScript(sb, ["wicked-garden", "--claude-home", sb.cfg, "--source-root", bogus, "--skip-binaries", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no \.claude-plugin\/marketplace\.json under/);
    assert.equal(r.stdout.trim(), "", "no report is emitted: the run never started");
    assert.ok(!existsSync(sb.cfg), "no config dir (and so no marker) was created");
    assert.ok(!existsSync(sb.stubLog), "claude was never invoked");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js: a set-but-empty CLAUDE_CONFIG_DIR is rejected (no --claude-home given)", () => {
  const sb = sandbox();
  try {
    const r = runScript(sb, ["wicked-garden", "--source-root", sb.srcRoot, "--skip-binaries", "--json"], { env: { CLAUDE_CONFIG_DIR: " : " } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /CLAUDE_CONFIG_DIR is set but names no directory/);
    assert.ok(!existsSync(join(sb.home, ".claude")), "~/.claude was never touched");
  } finally {
    cleanup(sb);
  }
});
