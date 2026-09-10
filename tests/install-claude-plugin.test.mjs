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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

/** Listing of a tree with a full-file sha256, size and mode per entry (links by target), to prove byte-identity. */
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      const st = lstatSync(f);
      const mode = (st.mode & 0o777).toString(8);
      const rel = relative(dir, f);
      if (e.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(f)} [link ${mode}]`);
      else if (e.isDirectory()) { out.push(`${rel}/ [${mode}]`); walk(f); }
      else out.push(`${rel} sha256=${createHash("sha256").update(readFileSync(f)).digest("hex")} size=${st.size} [${mode}]`);
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

/** A v1 (array-shaped) install-claude.js marker naming garden, plus the skill copy it made. */
function plantLegacyV1Marker(cfg) {
  mkdirSync(join(cfg, "skills", "wicked-garden-core"), { recursive: true });
  writeFileSync(join(cfg, "skills", "wicked-garden-core", "SKILL.md"), "---\nname: wicked-garden-core\n---\nwicked-garden\n");
  mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
  writeFileSync(markerPath(cfg), JSON.stringify({
    installedAt: "2025-12-01T00:00:00.000Z",
    claudeHome: cfg,
    products: [{ id: "wicked-garden", success: true, skipped: false, assets: { skills: 40, agents: 0, commands: 0 }, notes: ["assets source: npm-pack"] }],
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

test("install-claude.js fails closed on an unparseable marker: exit 1 before any write, marker bytes and config dir untouched", () => {
  const sb = sandbox();
  mkdirSync(join(sb.cfg, "wicked-installer"), { recursive: true });
  writeFileSync(markerPath(sb.cfg), "{ this is not json");
  writeFileSync(join(sb.cfg, "settings.json"), JSON.stringify({ theme: "dark" }));
  const before = snapshot(sb.cfg);
  try {
    for (const extra of [[], ["--dry-run"]]) {
      const r = runScript(sb, ["wicked-vault", "--claude-home", sb.cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json", ...extra]);
      assert.equal(r.status, 1, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${escapeRe(markerPath(sb.cfg))}: install marker is unusable \\(.+\\) — refusing to install`));
      assert.match(r.stderr, /Nothing was written/);
      assert.equal(r.stdout.trim(), "", "no report: the run stopped before doing anything");
      assert.deepEqual(snapshot(sb.cfg), before, `${extra.join(" ")}: marker bytes identical, no other writes in the config dir`);
    }
    // `status` names the corruption (exit 1) and `uninstall` skips the target — neither touches it.
    const st = runScript(sb, ["status", "wicked-vault", "--claude-home", sb.cfg, "--json"]);
    assert.equal(st.status, 1, st.stdout + st.stderr);
    assert.ok(JSON.parse(st.stdout).reports[0].notes.some((n) => /corrupt marker/.test(n)));
    // Corruption is a property of the config dir, not of the product selection: a plain `status`
    // and `status --all` — where a corrupt marker contributes no ids at all — still exit 1, with
    // the diagnostic on stderr and stdout still pure JSON.
    for (const args of [["status"], ["status", "--all"]]) {
      const r = runScript(sb, [...args, "--claude-home", sb.cfg, "--json"]);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${escapeRe(markerPath(sb.cfg))}: install marker is unusable \\(.+\\) — status cannot describe this config dir`));
      const report = JSON.parse(r.stdout);
      assert.equal(report.verb, "status");
      assert.deepEqual(report.reports, [], `${args.join(" ")}: no product-derived lines from an unparseable marker`);
    }
    const un = runScript(sb, ["uninstall", "wicked-vault", "--claude-home", sb.cfg, "--json"]);
    assert.equal(un.status, 0, un.stdout + un.stderr);
    assert.deepEqual(snapshot(sb.cfg), before, "status and uninstall leave the corrupt marker exactly as it was");

    // A marker PATH that is a symlink — dangling, or pointing at perfectly valid JSON — is never
    // followed and never replaced: existsSync would call a dangling link "absent" and let install
    // initialise a marker over it. lstat-based detection refuses both as corrupt.
    if (POSIX) {
      for (const name of ["dangling", "valid-target"]) {
        const cfg = join(sb.tmp, `cfg-link-${name}`);
        const external = join(sb.tmp, `external-${name}`);
        mkdirSync(external);
        const target = join(external, name === "dangling" ? "nowhere.json" : "valid-marker.json");
        mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
        writeFileSync(join(cfg, "settings.json"), "{}");
        if (name === "valid-target") writeFileSync(target, JSON.stringify({ markerVersion: 2, cli: "claude", configDir: cfg, updatedAt: "x", products: {} }));
        symlinkSync(target, markerPath(cfg));
        const snapCfg = snapshot(cfg);
        const snapExternal = snapshot(external); // the link TARGET's directory, byte-identity helper (sha256/size/mode/type)
        const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
        assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /install marker is unusable \(.*claude-install\.json: is a symlink — refusing to follow it\)/);
        assert.equal(r.stdout.trim(), "");
        assert.deepEqual(snapshot(cfg), snapCfg, `${name}: the config dir (link included) is untouched`);
        assert.deepEqual(snapshot(external), snapExternal, `${name}: the external target dir is untouched — nothing followed the link`);
        assert.ok(lstatSync(markerPath(cfg)).isSymbolicLink(), `${name}: still a symlink, not replaced by a file`);
      }

      // A symlinked PARENT (`wicked-installer/` → a dir outside cfg) with a regular or absent marker
      // behind it: the chain check refuses the parent, so the marker is never created or renamed
      // THROUGH the link — the external dir stays byte-identical.
      for (const variant of ["absent-marker", "regular-marker"]) {
        const cfg = join(sb.tmp, `cfg-parent-${variant}`);
        const external = join(sb.tmp, `external-parent-${variant}`);
        mkdirSync(cfg);
        mkdirSync(external);
        writeFileSync(join(cfg, "settings.json"), "{}");
        if (variant === "regular-marker") writeFileSync(join(external, "claude-install.json"), JSON.stringify({ markerVersion: 2, cli: "claude", configDir: cfg, updatedAt: "x", products: {} }));
        symlinkSync(external, join(cfg, "wicked-installer"));
        const snapCfg = snapshot(cfg);
        const snapExternal = snapshot(external);
        const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
        assert.equal(r.status, 1, `${variant}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /install marker is unusable \(.*[\\/]wicked-installer: is a symlink — refusing to follow it\)/);
        assert.equal(r.stdout.trim(), "");
        assert.deepEqual(snapshot(cfg), snapCfg, `${variant}: config dir untouched`);
        assert.deepEqual(snapshot(external), snapExternal, `${variant}: nothing was written at the link target`);
        assert.ok(!existsSync(join(external, "claude-install.json.wicked-tmp")) && readdirSync(external).every((n) => !n.includes("wicked-tmp")), `${variant}: no temp file leaked through the link`);
      }

      // Discovery without --claude-home: a DANGLING marker link in a dir with no other identity
      // must still count as "Claude present" (no exit 2), so plain `status` and `--all` reach the
      // unusable-marker diagnostic: stderr, pure-JSON stdout, exit 1.
      const bare = join(sb.tmp, "cfg-dangling-only");
      mkdirSync(join(bare, "wicked-installer"), { recursive: true });
      symlinkSync(join(sb.tmp, "nowhere-else.json"), markerPath(bare));
      for (const args of [["status"], ["status", "--all"]]) {
        const r = runScript(sb, [...args, "--json"], { env: { CLAUDE_CONFIG_DIR: bare } });
        assert.equal(r.status, 1, `${args.join(" ")} via CLAUDE_CONFIG_DIR: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /install marker is unusable \(.*is a symlink — refusing to follow it\) — status cannot describe this config dir/);
        const report = JSON.parse(r.stdout);
        assert.equal(report.verb, "status");
        assert.deepEqual(report.reports, []);
        assert.ok(lstatSync(markerPath(bare)).isSymbolicLink(), "the dangling link is untouched");
      }
    }
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

test("install-claude.js uninstall of a plugin removes NOTHING — legacy assets and the marker stay byte-identical; only `claude plugin uninstall` is named", () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyMarkerCopy(sb.cfg);
  writeFileSync(join(sb.cfg, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "mine" }] }] } }));
  const before = snapshot(sb.cfg);
  try {
    const r = runScript(sb, ["uninstall", "wicked-garden", "--claude-home", sb.cfg, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const garden = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.equal(garden.skipped, true);
    assert.match(garden.message, /Claude Code plugin — nothing removed by this script/);
    assert.deepEqual(garden.actions, []);
    assert.ok(garden.notes.some((n) => /remove it with: claude plugin uninstall wicked-garden@wicked-garden/.test(n)), JSON.stringify(garden.notes));
    assert.ok(garden.notes.some((n) => /a legacy copy recorded in .*claude-install\.json is left in place — removal will ship separately \(see .*issues\/20\)/.test(n)), JSON.stringify(garden.notes));
    assert.deepEqual(snapshot(sb.cfg), before, "legacy skill copy, marker and settings.json are byte-identical after `uninstall wicked-garden`");

    // A v1 (array) marker: same — nothing rewritten, not even the marker's shape.
    const v1 = join(sb.tmp, "cfg-v1");
    mkdirSync(v1);
    plantLegacyV1Marker(v1);
    const beforeV1 = snapshot(v1);
    const r1 = runScript(sb, ["uninstall", "wicked-garden", "--claude-home", v1, "--json"]);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const gardenV1 = JSON.parse(r1.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.equal(gardenV1.skipped, true);
    assert.ok(gardenV1.notes.some((n) => /is left in place/.test(n)));
    assert.deepEqual(snapshot(v1), beforeV1, "a v1 marker and its recorded skill copy are byte-identical too");

    const fresh = join(sb.tmp, "cfg-fresh");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "settings.json"), "{}");
    const r2 = runScript(sb, ["uninstall", "wicked-garden", "--claude-home", fresh, "--json"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    const garden2 = JSON.parse(r2.stdout).reports.find((x) => x.productId === "wicked-garden");
    assert.match(garden2.message, /nothing removed by this script/);
    assert.ok(garden2.notes.some((n) => /claude plugin uninstall wicked-garden@wicked-garden/.test(n)), JSON.stringify(garden2.notes));
    assert.ok(!garden2.notes.some((n) => /is left in place/.test(n)), "no legacy note when nothing is recorded");
    assert.ok(!existsSync(join(fresh, "wicked-installer")), "no marker was created by a notice-only run");
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

test("dispatch: a v1 (array) marker naming garden is reported BEFORE the script runs, and its garden record is carried forward untouched", { skip }, async () => {
  const sb = sandbox();
  mkdirSync(sb.cfg);
  plantLegacyV1Marker(sb.cfg);
  const beforeAll = snapshot(sb.cfg);
  const v1Text = readFileSync(markerPath(sb.cfg), "utf8");
  try {
    // Garden alone: the script does not run, so the v1 marker is not even upgraded — byte-identical.
    let { code, out } = await dispatch(sb, ["wicked-garden"], {});
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`legacy wicked-garden copy detected at ${escapeRe(markerPath(sb.cfg))} \\(install-claude\\.js v1 marker entry\\) — left in place`));
    const afterGardenOnly = snapshot(sb.cfg).filter((e) => !e.startsWith("plugins/"));
    assert.deepEqual(afterGardenOnly, beforeAll, "everything but the new plugins/ registration is byte-identical (marker included)");
    assert.equal(readFileSync(markerPath(sb.cfg), "utf8"), v1Text);

    // Garden + vault: the script runs for vault and upgrades the marker to v2 — the report was
    // printed BEFORE that, and the v1 garden record is carried forward, not dropped.
    rmSync(sb.stubLog);
    ({ code, out } = await dispatch(sb, ["wicked-vault", "wicked-garden"], {}));
    assert.equal(code, 0, out);
    const legacyAt = out.indexOf("legacy wicked-garden copy detected at");
    const scriptAt = out.indexOf("Installing into Claude Code");
    const registerAt = out.indexOf("— registered Claude Code plugin");
    assert.ok(legacyAt !== -1 && scriptAt !== -1 && registerAt !== -1, out);
    assert.ok(scriptAt < legacyAt && legacyAt < registerAt, "legacy report sits between the CLI header and the registration step, i.e. before the script's marker upgrade is used");
    assert.match(out, /\(install-claude\.js v1 marker entry\)/, "the v1 shape was what detection saw");
    const m = marker(sb.cfg);
    assert.equal(m.markerVersion, 2, "the script upgraded the marker for vault");
    assert.ok(m.products["wicked-vault"], "vault recorded");
    assert.deepEqual(m.products["wicked-garden"].files, [], "the carried-forward garden record has no file manifest");
    assert.equal(m.products["wicked-garden"].lastResult, "installed");
    assert.equal(m.products["wicked-garden"].installedAt, "2025-12-01T00:00:00.000Z");
    assert.deepEqual(m.products["wicked-garden"].assets, { skills: 40, agents: 0, commands: 0 });
    assert.ok(m.products["wicked-garden"].notes.includes("assets source: npm-pack"), "legacy notes kept");
    assert.ok(m.products["wicked-garden"].notes.some((n) => n.startsWith("carried forward from a v1 marker")));
    assert.equal(readFileSync(join(sb.cfg, "skills", "wicked-garden-core", "SKILL.md"), "utf8"), "---\nname: wicked-garden-core\n---\nwicked-garden\n", "the legacy skill copy is untouched");
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

    // With a valid --source-root the picker's Claude path is STILL the manual step (nothing to copy
    // either way); the source-root refusal belongs to the direct path, whose alternative is the published package.
    mkdirSync(join(sb.srcRoot, "wicked-garden", ".claude-plugin"), { recursive: true });
    writeFileSync(join(sb.srcRoot, "wicked-garden", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "wicked-garden" }));
    for (const dryRun of [false, true]) {
      const withRoot = await dispatch(sb, ["wicked-garden"], { dryRun, sourceRoot: sb.srcRoot }, { claude: false });
      assert.equal(withRoot.code, 0, withRoot.out);
      assert.match(withRoot.out, /manual step: install Claude Code, then re-run to register wicked-garden@wicked-garden/, `dryRun=${dryRun}`);
      assert.doesNotMatch(withRoot.out, /has no fallback/, `dryRun=${dryRun}: not the direct-path refusal`);
      assert.deepEqual(lines(sb.npmLog), [], "still nothing copied");
    }
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

test("install-claude.js never writes through a link: a planted backup leaf is left alone (fresh name), source symlinks are never planted, externals byte-identical", { skip }, () => {
  const sb = sandbox();
  try {
    const cfg = sb.cfg;
    const external = join(sb.tmp, "external");
    mkdirSync(external);
    writeFileSync(join(external, "victim.json"), JSON.stringify({ victim: true }));
    mkdirSync(join(external, "victim-dir"));
    writeFileSync(join(external, "victim-dir", "inner.txt"), "inner");

    // The vault source ships a skill (copied to skills/) and a hook (merged into settings.json, which
    // is therefore backed up). Both trees carry symlinks pointing at the external files.
    const vault = join(sb.srcRoot, "wicked-vault");
    const skill = join(vault, "skills", "wicked-vault-core");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: wicked-vault-core\n---\nvault\n");
    writeFileSync(join(skill, "real.md"), "real");
    symlinkSync(join(external, "victim.json"), join(skill, "linked-file.json"));
    symlinkSync(join(external, "victim-dir"), join(skill, "linked-dir"));
    mkdirSync(join(vault, "hooks"));
    writeFileSync(join(vault, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/hello.sh" }] }] } }));
    writeFileSync(join(vault, "hooks", "hello.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(join(external, "victim.json"), join(vault, "hooks", "linked.sh"));

    // A settings.json to back up, and a symlink pre-planted at EVERY predictable backup leaf the
    // run could pick (second-resolution stamp, a generous window), each pointing at the external file.
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "kept" }));
    const backups = join(cfg, "wicked-installer", "backups");
    mkdirSync(backups, { recursive: true });
    const planted = [];
    const start = Date.now();
    for (let sec = -5; sec <= 120; sec += 1) {
      const stamp = new Date(start + sec * 1000).toISOString().slice(0, 19).replace(/:/g, "-");
      const leaf = join(backups, `settings.json.${stamp}.bak`);
      symlinkSync(join(external, "victim.json"), leaf);
      planted.push(leaf);
    }
    const externalBefore = snapshot(external);

    const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(Date.now() - start < 120_000, "the run finished inside the planted window");

    // 1. Backup leaf: no planted link was followed or replaced; the backup went to a fresh unique name.
    assert.deepEqual(snapshot(external), externalBefore, "the external targets are byte-identical");
    for (const leaf of planted) assert.ok(lstatSync(leaf).isSymbolicLink(), `${leaf} is still the planted link`);
    const regularBackups = readdirSync(backups, { withFileTypes: true }).filter((e) => e.isFile());
    assert.equal(regularBackups.length, 1, "exactly one real backup was written");
    assert.match(regularBackups[0].name, /^settings\.json\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.[0-9a-f]{8}\.bak$/, "under a fresh unique name");
    assert.equal(readFileSync(join(backups, regularBackups[0].name), "utf8"), JSON.stringify({ theme: "kept" }), "holding the pre-install settings.json bytes");
    const settings = JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8"));
    assert.equal(settings.theme, "kept");
    assert.ok(Array.isArray(settings.hooks?.SessionStart) && settings.hooks.SessionStart.length === 1, "the hook was merged");

    // 2. copyTree: real files copied, source symlinks never planted, no link anywhere under cfg.
    const skillDest = join(cfg, "skills", "wicked-vault-core");
    assert.equal(readFileSync(join(skillDest, "real.md"), "utf8"), "real");
    assert.ok(existsSync(join(skillDest, "SKILL.md")));
    assert.ok(!existsSync(join(skillDest, "linked-file.json")) && !lstatSyncSafe(join(skillDest, "linked-file.json")), "file link not planted");
    assert.ok(!lstatSyncSafe(join(skillDest, "linked-dir")), "dir link not planted");
    const payloadHooks = join(cfg, "wicked-installer", "products", "wicked-vault", "hooks");
    assert.equal(readFileSync(join(payloadHooks, "hello.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
    assert.ok((lstatSync(join(payloadHooks, "hello.sh")).mode & 0o111) !== 0, "exec bit preserved");
    assert.ok(!lstatSyncSafe(join(payloadHooks, "linked.sh")), "hook link not planted");
    const linksUnderCfg = snapshot(cfg).filter((l) => l.includes("[link") && !l.startsWith("wicked-installer/backups/"));
    assert.deepEqual(linksUnderCfg, [], "no symlink anywhere under the config dir besides the pre-planted backup leaves");
    const report = JSON.parse(r.stdout);
    const text = JSON.stringify(report);
    assert.match(text, /symlinks in the source were not copied/, "the skipped links are reported");
    assert.match(text, /linked-file\.json/);
    assert.match(text, /linked\.sh/);
  } finally {
    cleanup(sb);
  }
});

/** lstat that reports absence as false instead of throwing (a dangling link is still "present"). */
function lstatSyncSafe(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

test("install-claude.js treats valid JSON of an unrecognised marker shape as unusable: install exits 1 byte-identical, status exits 1", () => {
  const sb = sandbox();
  try {
    const shapes = {
      "products-object": { products: {} },
      "array": [],
      "string": "not a marker",
      "v1-entry-without-id": { products: [{ noid: 1 }] },
    };
    for (const [name, shape] of Object.entries(shapes)) {
      const cfg = join(sb.tmp, `cfg-shape-${name}`);
      mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
      writeFileSync(join(cfg, "settings.json"), "{}");
      writeFileSync(markerPath(cfg), JSON.stringify(shape));
      const before = snapshot(cfg);
      const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /install marker is unusable \(unrecognised marker shape/, name);
      assert.equal(r.stdout.trim(), "", `${name}: no report`);
      assert.deepEqual(snapshot(cfg), before, `${name}: byte-identical`);
      const st = runScript(sb, ["status", "--claude-home", cfg, "--json"]);
      assert.equal(st.status, 1, `${name} status: ${st.stdout}${st.stderr}`);
      assert.match(st.stderr, /install marker is unusable \(unrecognised marker shape/, name);
      assert.equal(JSON.parse(st.stdout).verb, "status", `${name}: stdout stays pure JSON`);
      assert.deepEqual(snapshot(cfg), before, `${name}: status wrote nothing`);
    }
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js handed ONLY plugins (after dependency expansion) creates no config dir, initialises no marker and upgrades no v1 marker", () => {
  const sb = sandbox();
  try {
    // A registry whose plugin has no dependencies, so the selection stays plugin-only.
    const registry = join(sb.tmp, "registry.json");
    writeFileSync(registry, JSON.stringify({
      version: "1",
      products: [{
        id: "fake-plugin", displayName: "Fake Plugin", description: "", type: "claude-plugin", standalone: true, opinionated: false, status: "active", requires: [],
        install: { type: "npm-run", package: "fake-plugin-pkg", command: "install", marketplace: "acme/fake-plugin", pluginId: "fake-plugin@fake-plugin" },
      }],
    }));
    // 1. A config dir that does not exist yet stays absent.
    const fresh = join(sb.tmp, "cfg-fresh");
    const r = runScript(sb, ["fake-plugin", "--registry", registry, "--claude-home", fresh, "--skip-binaries", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout).reports.find((x) => x.productId === "fake-plugin");
    assert.equal(report.skipped, true);
    assert.match(report.message, /Claude Code plugin — registered by the central installer/);
    assert.ok(!existsSync(fresh), "the config dir was not created");
    assert.ok(!existsSync(sb.stubLog), "claude never invoked");
    // 2. A config dir holding a v1 marker (and a legacy copy) stays byte-identical: no upgrade, no skills/ dir.
    const legacy = join(sb.tmp, "cfg-v1");
    plantLegacyV1Marker(legacy);
    const before = snapshot(legacy);
    const r2 = runScript(sb, ["fake-plugin", "--registry", registry, "--claude-home", legacy, "--skip-binaries", "--json"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.deepEqual(snapshot(legacy), before, "the v1 marker and everything else are untouched");
    // 3. With a real dependency in the selection the normal path still runs (the existing garden+vault test covers it);
    //    the unusable-marker check still comes first even for a plugin-only selection.
    const corrupt = join(sb.tmp, "cfg-corrupt");
    mkdirSync(join(corrupt, "wicked-installer"), { recursive: true });
    writeFileSync(markerPath(corrupt), "{ nope");
    const snapC = snapshot(corrupt);
    const r3 = runScript(sb, ["fake-plugin", "--registry", registry, "--claude-home", corrupt, "--skip-binaries", "--json"]);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /install marker is unusable/);
    assert.deepEqual(snapshot(corrupt), snapC);
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js validates every v2 product and file record at parse time: a malformed record makes the marker unusable (exit 1, byte-identical)", () => {
  const sb = sandbox();
  try {
    const good = { installedAt: "2026-01-01T00:00:00.000Z", lastResult: "installed", files: [], notes: [] };
    const top = { markerVersion: 2, cli: "claude", configDir: "cfg", updatedAt: "2026-01-01T00:00:00.000Z" };
    const shapes = {
      "no-products": { ...top },
      "products-array": { ...top, products: [] },
      "no-cli": { markerVersion: 2, configDir: "cfg", updatedAt: "t", products: {} },
      "no-configDir": { markerVersion: 2, cli: "claude", updatedAt: "t", products: {} },
      "no-updatedAt": { markerVersion: 2, cli: "claude", configDir: "cfg", products: {} },
      "assets-negative": { ...top, products: { x: { ...good, assets: { skills: -1 } } } },
      "assets-fraction": { ...top, products: { x: { ...good, assets: { skills: 1.5 } } } },
      "record-empty": { ...top, products: { x: {} } },
      "record-files-string": { ...top, products: { x: { ...good, files: "nope" } } },
      "record-notes-string": { ...top, products: { x: { ...good, notes: "nope" } } },
      "record-lastResult": { ...top, products: { x: { ...good, lastResult: "weird" } } },
      "record-version-number": { ...top, products: { x: { ...good, version: 1 } } },
      "file-dir-no-path": { ...top, products: { x: { ...good, files: [{ kind: "dir" }] } } },
      "file-string": { ...top, products: { x: { ...good, files: ["skills/x"] } } },
      "file-json-key-no-hash": { ...top, products: { x: { ...good, files: [{ kind: "json-key", file: "f", pointer: "/a" }] } } },
      "file-hooks-no-owner": { ...top, products: { x: { ...good, files: [{ kind: "hooks-entry", file: "f", event: "E", ownerMatch: {} }] } } },
      "file-unknown-kind": { ...top, products: { x: { ...good, files: [{ kind: "bogus", path: "x" }] } } },
    };
    for (const [name, shape] of Object.entries(shapes)) {
      const cfg = join(sb.tmp, `cfg-v2-${name}`);
      mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
      writeFileSync(join(cfg, "settings.json"), "{}");
      writeFileSync(markerPath(cfg), JSON.stringify(shape));
      const before = snapshot(cfg);
      const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /install marker is unusable \(malformed v2 marker: /, name);
      assert.equal(r.stdout.trim(), "", `${name}: no report`);
      assert.deepEqual(snapshot(cfg), before, `${name}: byte-identical — never flushed`);
      const st = runScript(sb, ["status", "--claude-home", cfg, "--json"]);
      assert.equal(st.status, 1, `${name} status`);
      assert.match(st.stderr, /malformed v2 marker: /, name);
      assert.deepEqual(snapshot(cfg), before, `${name}: status wrote nothing`);
    }
    // …and a sound marker with every record kind still loads.
    const ok = join(sb.tmp, "cfg-v2-ok");
    mkdirSync(join(ok, "wicked-installer"), { recursive: true });
    writeFileSync(markerPath(ok), JSON.stringify({ markerVersion: 2, cli: "claude", configDir: ok, updatedAt: "x", products: { y: { ...good, version: "1.0.0", source: "local", assets: { skills: 1 }, files: [
      { kind: "dir", path: "skills/y" }, { kind: "json-key", file: ".claude.json", pointer: "/mcpServers/y", wroteHash: "abc" }, { kind: "hooks-entry", file: "settings.json", event: "SessionStart", ownerMatch: { commandContains: "wicked-installer/products/y" } },
    ] } } }));
    const st = runScript(sb, ["status", "--claude-home", ok, "--json"]);
    assert.equal(st.status, 0, st.stdout + st.stderr);
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js never reads a source manifest through a symlink: a linked hooks.json wires nothing, linked skills are skipped and reported, a real skill still installs", () => {
  const sb = sandbox();
  try {
    const cfg = sb.cfg;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "kept" }));
    const external = join(sb.tmp, "external");
    mkdirSync(join(external, "skilldir"), { recursive: true });
    writeFileSync(join(external, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/evil.sh" }] }] } }));
    writeFileSync(join(external, "skilldir", "SKILL.md"), "---\nname: wicked-vault-evil\n---\nevil\n");
    writeFileSync(join(external, "SKILL.md"), "---\nname: wicked-vault-evil2\n---\nevil\n");
    const vault = join(sb.srcRoot, "wicked-vault");
    mkdirSync(join(vault, "hooks"));
    writeFileSync(join(vault, "hooks", "evil.sh"), "#!/bin/sh\n");
    symlinkSync(join(external, "hooks.json"), join(vault, "hooks", "hooks.json"));
    mkdirSync(join(vault, "skills", "good"), { recursive: true });
    writeFileSync(join(vault, "skills", "good", "SKILL.md"), "---\nname: wicked-vault-good\n---\ngood\n");
    symlinkSync(join(external, "skilldir"), join(vault, "skills", "linked-dir"));
    mkdirSync(join(vault, "skills", "linked-manifest"));
    symlinkSync(join(external, "SKILL.md"), join(vault, "skills", "linked-manifest", "SKILL.md"));
    const externalBefore = snapshot(external);

    const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout).reports.find((x) => x.productId === "wicked-vault");
    // hooks: the linked manifest was never read — nothing from it reached settings.json, no payload copied
    assert.deepEqual(JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")), { theme: "kept" }, "settings.json untouched");
    assert.ok(!existsSync(join(cfg, "wicked-installer", "products", "wicked-vault")), "no hooks payload copied");
    const hookRefusal = report.actions.find((a) => a.kind === "merge-hook" && a.result === "skipped");
    assert.ok(hookRefusal && /refused: source manifest .*hooks[\\/]hooks\.json: is a symlink/.test(hookRefusal.detail), JSON.stringify(report.actions));
    // skills: the linked ones are skipped and named; the real one installs
    const skipped = report.actions.filter((a) => a.kind === "copy-skill" && a.result === "skipped").map((a) => a.target).sort();
    assert.deepEqual(skipped, ["skills/linked-dir", "skills/linked-manifest/SKILL.md"]);
    assert.ok(existsSync(join(cfg, "skills", "wicked-vault-good", "SKILL.md")), "the real skill installed");
    assert.ok(!existsSync(join(cfg, "skills", "wicked-vault-evil")) && !existsSync(join(cfg, "skills", "wicked-vault-evil2")), "nothing named after an external manifest");
    assert.ok(!existsSync(join(cfg, "skills", "linked-dir")) && !existsSync(join(cfg, "skills", "linked-manifest")));
    assert.deepEqual(snapshot(external), externalBefore, "externals byte-identical");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js: a refused backup fails the write it protects, for EVERY product touching the file — nothing is remembered as backed up", () => {
  const sb = sandbox();
  try {
    const cfg = sb.cfg;
    mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
    const settingsBytes = JSON.stringify({ theme: "kept" });
    writeFileSync(join(cfg, "settings.json"), settingsBytes);
    const external = join(sb.tmp, "external-backups");
    mkdirSync(external);
    symlinkSync(external, join(cfg, "wicked-installer", "backups")); // planted PARENT link: every backup is refused
    for (const [id, script] of [["wicked-vault", "hello.sh"], ["wicked-bus", "hi.sh"]]) {
      const src = join(sb.srcRoot, id);
      mkdirSync(join(src, "hooks"), { recursive: true });
      if (!existsSync(join(src, "package.json"))) writeFileSync(join(src, "package.json"), JSON.stringify({ name: id, version: "0.0.0-test" }));
      writeFileSync(join(src, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `\${CLAUDE_PLUGIN_ROOT}/hooks/${script}` }] }] } }));
      writeFileSync(join(src, "hooks", script), "#!/bin/sh\n", { mode: 0o755 });
    }
    const externalBefore = snapshot(external);
    const r = runScript(sb, ["wicked-vault", "wicked-bus", "--claude-home", cfg, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(readFileSync(join(cfg, "settings.json"), "utf8"), settingsBytes, "settings.json was not modified by either product");
    assert.deepEqual(snapshot(external), externalBefore, "nothing was written through the planted backups link");
    const reports = JSON.parse(r.stdout).reports;
    for (const id of ["wicked-vault", "wicked-bus"]) {
      const rep = reports.find((x) => x.productId === id);
      assert.equal(rep.success, false, `${id} failed`);
      assert.match(rep.message, /settings\.json: not written — backup refused: .*wicked-installer[\\/]backups: is a symlink/, id);
      const failed = rep.actions.filter((a) => a.kind === "merge-hook" && a.result === "failed");
      assert.ok(failed.length >= 1 && failed.every((a) => /backup refused/.test(a.detail)), `${id}: ${JSON.stringify(rep.actions)}`);
    }
    assert.ok(lstatSync(join(cfg, "wicked-installer", "backups")).isSymbolicLink(), "the planted link is untouched");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js destination links: a symlinked skill destination dir is refused, a file-leaf link inside an owned payload is unlinked never followed, a symlinked settings.json is refused — externals byte-identical", () => {
  const sb = sandbox();
  try {
    const external = join(sb.tmp, "external");
    mkdirSync(join(external, "skilldir"), { recursive: true });
    writeFileSync(join(external, "skilldir", "keep.md"), "keep");
    writeFileSync(join(external, "victim.json"), JSON.stringify({ victim: true }));
    writeFileSync(join(external, "settings.json"), JSON.stringify({ external: true }));
    const vault = join(sb.srcRoot, "wicked-vault");
    mkdirSync(join(vault, "skills", "wicked-vault-core"), { recursive: true });
    writeFileSync(join(vault, "skills", "wicked-vault-core", "SKILL.md"), "---\nname: wicked-vault-core\n---\nvault\n");
    mkdirSync(join(vault, "hooks"));
    writeFileSync(join(vault, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/hello.sh" }] }] } }));
    writeFileSync(join(vault, "hooks", "hello.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const externalBefore = snapshot(external);

    // (a) destination DIRECTORY link at skills/<name> → refused, the product fails, nothing followed
    const a = join(sb.tmp, "cfg-dir-link");
    mkdirSync(join(a, "skills"), { recursive: true });
    writeFileSync(join(a, "settings.json"), "{}");
    symlinkSync(join(external, "skilldir"), join(a, "skills", "wicked-vault-core"));
    const ra = runScript(sb, ["wicked-vault", "--claude-home", a, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(ra.status, 1, ra.stdout + ra.stderr);
    const repA = JSON.parse(ra.stdout).reports.find((x) => x.productId === "wicked-vault");
    assert.match(repA.message, /skills[\\/]wicked-vault-core: is a symlink — refusing to follow it/);
    assert.ok(lstatSync(join(a, "skills", "wicked-vault-core")).isSymbolicLink(), "the link is untouched");
    assert.deepEqual(snapshot(external), externalBefore, "(a) external byte-identical");

    // (b) destination FILE-LEAF link inside an owned payload root → the payload is replaced; the link is
    //     unlinked, never followed; the fresh file is a regular file with the source bytes
    const b = join(sb.tmp, "cfg-leaf-link");
    mkdirSync(join(b, "wicked-installer", "products", "wicked-vault", "hooks"), { recursive: true });
    writeFileSync(join(b, "settings.json"), "{}");
    symlinkSync(join(external, "victim.json"), join(b, "wicked-installer", "products", "wicked-vault", "hooks", "hello.sh"));
    const rb = runScript(sb, ["wicked-vault", "--claude-home", b, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(rb.status, 0, rb.stdout + rb.stderr);
    const leaf = join(b, "wicked-installer", "products", "wicked-vault", "hooks", "hello.sh");
    assert.ok(lstatSync(leaf).isFile() && !lstatSync(leaf).isSymbolicLink(), "a regular file now");
    assert.equal(readFileSync(leaf, "utf8"), "#!/bin/sh\nexit 0\n");
    assert.deepEqual(snapshot(external), externalBefore, "(b) external byte-identical");

    // (c) a symlinked settings.json (file leaf on the write path) → refused, named, nothing written through it
    const c = join(sb.tmp, "cfg-settings-link");
    mkdirSync(c);
    symlinkSync(join(external, "settings.json"), join(c, "settings.json"));
    const rc = runScript(sb, ["wicked-vault", "--claude-home", c, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    const repC = JSON.parse(rc.stdout).reports.find((x) => x.productId === "wicked-vault");
    const refusal = repC.actions.find((x) => x.kind === "merge-hook" && x.result === "failed");
    assert.ok(refusal && /refused: .*is a symlink/.test(refusal.detail), JSON.stringify(repC.actions));
    assert.ok(lstatSync(join(c, "settings.json")).isSymbolicLink(), "still a link");
    assert.deepEqual(snapshot(external), externalBefore, "(c) external byte-identical");
  } finally {
    cleanup(sb);
  }
});

test("install-claude.js collapses a repeated --claude-home (and CLAUDE_CONFIG_DIR a:a) to ONE target, like the central resolver", () => {
  const sb = sandbox();
  try {
    const cfg = sb.cfg;
    mkdirSync(cfg, { recursive: true });
    const r = runScript(sb, ["wicked-vault", "--claude-home", cfg, "--claude-home", `${cfg}/`, "--source-root", sb.srcRoot, "--skip-binaries", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.configDirs, [cfg], "one target, not two");
    assert.ok(!report.reports.some((x) => x.notes.some((n) => /fanned out/.test(n))), "no fan-out note for a single dir");
    const env = runScript(sb, ["status", "--json"], { env: { CLAUDE_CONFIG_DIR: `${cfg}:${cfg}` } });
    assert.equal(env.status, 0, env.stdout + env.stderr);
    assert.deepEqual(JSON.parse(env.stdout).configDirs, [cfg]);
  } finally {
    cleanup(sb);
  }
});
