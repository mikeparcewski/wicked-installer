// garden-registration.test.mjs — wicked-garden is installed as a REGISTERED Claude Code plugin (#18).
//
// Claude Code loads plugins from <configDir>/plugins/cache/<marketplace>/<plugin>/<version>/ and only
// when installed_plugins.json records them; `npx wicked-garden install` copied files to
// ~/.claude/plugins/wicked-garden (ignoring CLAUDE_CONFIG_DIR) and registered nothing, so neither
// Claude Code nor wicked-crew's skills discovery ever saw it.
//
// Network-free and sandboxed: WICKED_CLAUDE_BIN points at tests/claude-stub.mjs, a spawn-recording
// fake that emulates the real CLI's on-disk effects inside CLAUDE_CONFIG_DIR only; npm/npx on PATH are
// shell fakes that log their argv; HOME is a temp dir. The env is built from scratch (never spread from
// process.env) so a developer's own CLAUDE_CONFIG_DIR can never leak into a test. The PATH fakes are
// POSIX shell scripts, so these live-path tests are skipped on Windows (dry-run.test.mjs is not).
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const STUB = join(__dirname, "claude-stub.mjs");
const POSIX = process.platform !== "win32";
const skip = POSIX ? false : "PATH fakes are POSIX shell scripts";

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-garden-reg-"));
  const home = join(tmp, "home");
  const bin = join(tmp, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  for (const name of ["npm", "npx"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$FAKE_NPM_LOG"\nexit 0\n`, { mode: 0o755 });
  }
  return { tmp, home, bin, stubLog: join(tmp, "claude-stub.log"), npmLog: join(tmp, "npm.log") };
}

function run(sb, args, { configDir, claude = true, env: extra = {} } = {}) {
  const env = {
    PATH: `${sb.bin}:${dirname(process.execPath)}`,
    HOME: sb.home,
    USERPROFILE: sb.home,
    CLAUDE_STUB_LOG: sb.stubLog,
    FAKE_NPM_LOG: sb.npmLog,
    ...extra,
  };
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
  if (claude) env.WICKED_CLAUDE_BIN = STUB;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 120_000 });
}

const jsonLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const calls = (sb) => jsonLines(sb.stubLog).map((c) => [c.configDir, c.argv.join(" ")]);
const cleanup = (sb) => rmSync(sb.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const cacheDir = (cfg, version = "0.0.1-stub") => join(cfg, "plugins", "cache", "wicked-garden", "wicked-garden", version);

test("install wicked-garden registers the plugin in the active CLAUDE_CONFIG_DIR through Claude Code's own CLI", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg });
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // The exact sequence, every call pinned to the target dir: probe, then list→add, list→install.
    assert.deepEqual(calls(sb), [
      [cfg, "--version"],
      [cfg, "plugin marketplace list --json"],
      [cfg, "plugin marketplace add mikeparcewski/wicked-garden"],
      [cfg, "plugin list --json"],
      [cfg, "plugin install wicked-garden@wicked-garden"],
    ]);
    assert.ok(existsSync(cacheDir(cfg)), "the payload lands where Claude Code loads from (and crew reads)");
    assert.ok(!existsSync(join(sb.home, ".claude", "plugins", "wicked-garden")), "no bare copy under ~/.claude");
    assert.match(r.stdout, /registered with Claude Code as wicked-garden@wicked-garden/);
    assert.match(r.stdout, new RegExp(`registered wicked-garden@wicked-garden 0\\.0\\.1-stub → ${cacheDir(cfg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // The required dependency still installs (through the fake npm — network-free) and garden's own
    // install.mjs is NOT run: the bare copy is only the no-Claude fallback.
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault"]);
  } finally {
    cleanup(sb);
  }
});

test("a second install updates instead of re-adding the marketplace or re-installing", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    assert.equal(run(sb, ["install", "wicked-garden"], { configDir: cfg }).status, 0);
    rmSync(sb.stubLog);
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, env: { CLAUDE_STUB_VERSION: "0.0.2-stub" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const seq = calls(sb).map(([, argv]) => argv);
    assert.ok(seq.includes("plugin update wicked-garden@wicked-garden"), `expected an update, got ${JSON.stringify(seq)}`);
    assert.ok(!seq.some((a) => a.startsWith("plugin marketplace add")), "marketplace add must be idempotent (list first)");
    assert.ok(!seq.includes("plugin install wicked-garden@wicked-garden"), "an installed plugin is updated, not re-installed");
    assert.match(r.stdout, /marketplace wicked-garden already registered \(github:mikeparcewski\/wicked-garden\); keeping it/);
    assert.ok(existsSync(cacheDir(cfg, "0.0.2-stub")), "the update populated the new cache version");
    assert.match(r.stdout, /\(0\.0\.2-stub\)/);
  } finally {
    cleanup(sb);
  }
});

test("a multi-path CLAUDE_CONFIG_DIR registers into every listed dir", { skip }, () => {
  const sb = sandbox();
  const a = join(sb.tmp, "cfg-a");
  const b = join(sb.tmp, "cfg-b");
  mkdirSync(a);
  mkdirSync(b);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: `${a}:${b}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const dir of [a, b]) {
      const mine = calls(sb).filter(([d]) => d === dir).map(([, argv]) => argv);
      assert.ok(mine.includes("plugin marketplace add mikeparcewski/wicked-garden"), `${dir}: marketplace add`);
      assert.ok(mine.includes("plugin install wicked-garden@wicked-garden"), `${dir}: plugin install`);
      assert.ok(existsSync(cacheDir(dir)), `${dir}: cache payload`);
    }
    assert.match(r.stdout, /in 2 config dir\(s\) from CLAUDE_CONFIG_DIR/);
  } finally {
    cleanup(sb);
  }
});

test("--claude-home replaces CLAUDE_CONFIG_DIR as the target set", { skip }, () => {
  const sb = sandbox();
  const envDir = join(sb.tmp, "cfg-env");
  const flagDir = join(sb.tmp, "cfg-flag");
  mkdirSync(envDir);
  try {
    const r = run(sb, ["install", "wicked-garden", "--claude-home", flagDir], { configDir: envDir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dirs = new Set(jsonLines(sb.stubLog).map((c) => c.configDir));
    assert.deepEqual([...dirs], [flagDir], "every claude call must be pinned to the --claude-home dir");
    assert.ok(existsSync(cacheDir(flagDir)));
    assert.ok(!existsSync(join(envDir, "plugins")), "the env dir must be untouched");
  } finally {
    cleanup(sb);
  }
});

test("without CLAUDE_CONFIG_DIR the default ~/.claude is the target", { skip }, () => {
  const sb = sandbox();
  try {
    const r = run(sb, ["install", "wicked-garden"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const expected = join(sb.home, ".claude");
    assert.deepEqual([...new Set(jsonLines(sb.stubLog).map((c) => c.configDir))], [expected]);
    assert.ok(existsSync(cacheDir(expected)));
  } finally {
    cleanup(sb);
  }
});

test("--source-root registers the local checkout <root>/wicked-garden as the marketplace", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  const root = join(sb.tmp, "checkouts");
  const checkout = join(root, "wicked-garden");
  mkdirSync(cfg);
  mkdirSync(join(checkout, ".claude-plugin"), { recursive: true });
  writeFileSync(join(checkout, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "wicked-garden", plugins: [{ name: "wicked-garden", source: "./" }] }));
  try {
    const r = run(sb, ["install", "wicked-garden", "--source-root", root], { configDir: cfg });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(calls(sb).some(([, argv]) => argv === `plugin marketplace add ${checkout}`), JSON.stringify(calls(sb)));
    const known = JSON.parse(readFileSync(join(cfg, "plugins", "known_marketplaces.json"), "utf8"));
    assert.equal(known["wicked-garden"].source.source, "directory");
    assert.equal(known["wicked-garden"].source.path, checkout);
  } finally {
    cleanup(sb);
  }
});

test("--source-root without Claude Code fails rather than silently installing the published package", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  const root = join(sb.tmp, "checkouts");
  mkdirSync(cfg);
  mkdirSync(join(root, "wicked-garden", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "wicked-garden", ".claude-plugin", "marketplace.json"), "{}");
  try {
    const r = run(sb, ["install", "wicked-garden", "--source-root", root], { configDir: cfg, claude: false });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /--source-root .* has no fallback/);
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault"], "the dependency installs; the npx fallback does not run");
    assert.ok(!existsSync(join(cfg, "plugins")), "nothing claims to be registered");
  } finally {
    cleanup(sb);
  }
});

test("without Claude Code the installer falls back to the bare copy and says it is unregistered", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, claude: false });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault", "npx wicked-garden install"]);
    assert.ok(!existsSync(sb.stubLog), "no claude calls when it is absent");
    assert.match(r.stdout, /Claude Code not detected \(claude is not on PATH\); falling back to npx wicked-garden install/);
    assert.match(r.stdout, new RegExp(`copied to ${join(sb.home, ".claude", "plugins", "wicked-garden").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} via npx wicked-garden install; not registered — Claude Code not detected`));
  } finally {
    cleanup(sb);
  }
});

test("a failing claude subcommand fails the install with the rendered command", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, env: { CLAUDE_STUB_FAIL: "install" } });
    assert.equal(r.status, 1, "exit 1 on a failed registration");
    // add/install/update run with inherited stdio so Claude Code's own progress (and any consent
    // prompt it raises) reaches the user directly — so the CLI's stderr is on OUR stderr, and the
    // installer's message carries the rendered command + exit code.
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${cfg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} claude plugin install wicked-garden@wicked-garden failed \\(exit 1\\)`));
    assert.match(r.stderr, /stub: plugin install failed/);
    assert.match(r.stdout, /1 installation\(s\) failed/);
    assert.ok(!existsSync(cacheDir(cfg)), "nothing claims to be installed");
  } finally {
    cleanup(sb);
  }
});

test("status reports the registration per config dir and flags a bare copy as copy only (unregistered), without invoking claude", { skip }, () => {
  const sb = sandbox();
  const registered = join(sb.tmp, "cfg-registered");
  const bare = join(sb.tmp, "cfg-bare");
  const empty = join(sb.tmp, "cfg-empty");
  const broken = join(sb.tmp, "cfg-broken");
  mkdirSync(registered);
  mkdirSync(join(bare, "plugins", "wicked-garden", ".claude-plugin"), { recursive: true });
  writeFileSync(join(bare, "plugins", "wicked-garden", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "12.0.0" }));
  mkdirSync(empty);
  // A leftover install record with no marketplace entry and no payload on disk.
  mkdirSync(join(broken, "plugins"), { recursive: true });
  writeFileSync(join(broken, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: cacheDir(broken, "9.9.9"), version: "9.9.9" }] },
  }));
  try {
    assert.equal(run(sb, ["install", "wicked-garden"], { configDir: registered }).status, 0);
    const statusLog = join(sb.tmp, "status-stub.log");

    const a = run(sb, ["status"], { configDir: registered, env: { CLAUDE_STUB_LOG: statusLog } });
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /Claude Code plugin registration \(wicked-garden@wicked-garden\)/);
    assert.match(a.stdout, /marketplace: wicked-garden ← github:mikeparcewski\/wicked-garden/);
    assert.match(a.stdout, /installed:\s+0\.0\.1-stub \(user\)/);
    assert.match(a.stdout, /cache:\s+0\.0\.1-stub/);
    assert.match(a.stdout, /state:\s+✓ registered/);
    assert.match(a.stdout, /✓ installed\s+wicked-garden/, "the product list counts a registration as installed");

    const b = run(sb, ["status"], { configDir: bare, env: { CLAUDE_STUB_LOG: statusLog } });
    assert.equal(b.status, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /marketplace: not registered/);
    assert.match(b.stdout, /installed:\s+not installed/);
    assert.match(b.stdout, /bare copy:\s+.*plugins[\\/]wicked-garden \(v12\.0\.0\) — copy only \(unregistered\)/);
    assert.match(b.stdout, /state:\s+~ copy only \(unregistered\)/);
    assert.match(b.stdout, /not installed\s+wicked-garden/, "a bare copy is not 'installed' in the product list: Claude Code cannot load it");

    const c = run(sb, ["status"], { configDir: empty, env: { CLAUDE_STUB_LOG: statusLog } });
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.match(c.stdout, /state:\s+not installed/);
    assert.match(c.stdout, /not installed\s+wicked-garden/);

    // A stale install record is a BROKEN registration, and the product list agrees.
    const e = run(sb, ["status"], { configDir: broken, env: { CLAUDE_STUB_LOG: statusLog } });
    assert.equal(e.status, 0, e.stdout + e.stderr);
    assert.match(e.stdout, /installed:\s+9\.9\.9 \(user\)/);
    assert.match(e.stdout, /state:\s+✗ broken registration — marketplace entry missing.*; payload missing/);
    assert.match(e.stdout, /not installed\s+wicked-garden/, "a stale record is not 'installed' in the product list either");

    // --claude-home works for status too, and a multi-dir env renders every dir.
    const d = run(sb, ["status", "--claude-home", registered], { configDir: empty, env: { CLAUDE_STUB_LOG: statusLog } });
    assert.match(d.stdout, /from --claude-home/);
    assert.match(d.stdout, /state:\s+✓ registered/);

    assert.ok(!existsSync(statusLog), "status is read-only: it must never invoke the claude CLI");
  } finally {
    cleanup(sb);
  }
});

test("status points out a bare copy in ~/.claude when that is not an active config dir", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  const legacy = join(sb.home, ".claude", "plugins", "wicked-garden", ".claude-plugin");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "11.0.0" }));
  try {
    const r = run(sb, ["status"], { configDir: cfg });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /is not an active config dir but holds a bare copy at .*plugins[\\/]wicked-garden \(v11\.0\.0\) — copy only \(unregistered\)/);
  } finally {
    cleanup(sb);
  }
});
