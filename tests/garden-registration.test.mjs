// garden-registration.test.mjs — wicked-garden is installed as a REGISTERED Claude Code plugin (#18).
//
// Claude Code loads plugins from <configDir>/plugins/cache/<marketplace>/<plugin>/<version>/ and only
// when installed_plugins.json records them; `npx wicked-garden install` copied files to
// ~/.claude/plugins/wicked-garden (ignoring CLAUDE_CONFIG_DIR) and registered nothing, so neither
// Claude Code nor wicked-crew's skills discovery ever saw it.
//
// Network-free and sandboxed: the Claude Code CLI is tests/claude-stub.mjs — a spawn-recording fake
// that emulates the real CLI's on-disk effects inside CLAUDE_CONFIG_DIR only — reached either through
// WICKED_CLAUDE_BIN or as a real `claude` on PATH; npm/npx on PATH are shell fakes that log their argv;
// HOME is a temp dir. The env is built from scratch (never spread from process.env) so a developer's
// own CLAUDE_CONFIG_DIR can never leak into a test. The PATH fakes are POSIX shell scripts, so these
// live-path tests are skipped on Windows (dry-run.test.mjs and claude-plugin-unit.test.mjs are not).
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Put the stub on PATH as a real `claude` executable (the non-seam way the installer finds it). */
function claudeOnPath(sb) {
  writeFileSync(join(sb.bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`, { mode: 0o755 });
}

/**
 * `claude`: "seam" → WICKED_CLAUDE_BIN points at the stub; "path" → only the PATH `claude` (see
 * claudeOnPath); false → no claude anywhere.
 */
function run(sb, args, { configDir, claude = "seam", env: extra = {} } = {}) {
  const env = {
    PATH: `${sb.bin}:${dirname(process.execPath)}`,
    HOME: sb.home,
    USERPROFILE: sb.home,
    CLAUDE_STUB_LOG: sb.stubLog,
    FAKE_NPM_LOG: sb.npmLog,
    ...extra,
  };
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
  if (claude === "seam") env.WICKED_CLAUDE_BIN = STUB;
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

    // The exact sequence, every call pinned to the target dir: the probe, then only the commands
    // the on-disk state called for. No `claude plugin … list` — those write .claude.json.
    assert.deepEqual(calls(sb), [
      [cfg, "--version"],
      [cfg, "plugin marketplace add mikeparcewski/wicked-garden"],
      [cfg, "plugin install wicked-garden@wicked-garden"],
    ]);
    assert.match(r.stdout, /probe: .*claude-stub\.mjs --version → 9\.9\.9 \(Claude Code stub\)/);
    assert.match(r.stdout, new RegExp(`probe: ${escapeRe(join(cfg, "plugins", "known_marketplaces.json"))} → marketplace wicked-garden: not registered`));
    assert.ok(existsSync(cacheDir(cfg)), "the payload lands where Claude Code loads from (and crew reads)");
    assert.ok(!existsSync(join(sb.home, ".claude", "plugins", "wicked-garden")), "no bare copy under ~/.claude");
    assert.match(r.stdout, /registered with Claude Code as wicked-garden@wicked-garden/);
    assert.match(r.stdout, new RegExp(`registered wicked-garden@wicked-garden 0\\.0\\.1-stub → ${escapeRe(cacheDir(cfg))}`));

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
    assert.deepEqual(calls(sb), [
      [cfg, "--version"],
      [cfg, "plugin update wicked-garden@wicked-garden"],
    ], "marketplace add is idempotent; an installed plugin is updated, not re-installed");
    assert.match(r.stdout, /probe: .*known_marketplaces\.json → marketplace wicked-garden: registered \(github:mikeparcewski\/wicked-garden\)/);
    assert.match(r.stdout, /claude plugin update wicked-garden@wicked-garden\s+\(installed 0\.0\.1-stub \(user\)\)/);
    assert.ok(existsSync(cacheDir(cfg, "0.0.2-stub")), "the update populated the new cache version");
    assert.match(r.stdout, /\(0\.0\.2-stub\)/);
  } finally {
    cleanup(sb);
  }
});

test("a partial registration (record without payload) is repaired with `plugin install`, not `update`", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    assert.equal(run(sb, ["install", "wicked-garden"], { configDir: cfg }).status, 0);
    rmSync(cacheDir(cfg), { recursive: true, force: true }); // the payload vanishes; the record stays
    rmSync(sb.stubLog);
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(calls(sb).map(([, argv]) => argv), ["--version", "plugin install wicked-garden@wicked-garden"]);
    assert.match(r.stdout, /claude plugin install wicked-garden@wicked-garden\s+\(install record present but user scope: payload dir missing/);
    assert.ok(existsSync(cacheDir(cfg)), "repaired");
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
    assert.deepEqual([...new Set(jsonLines(sb.stubLog).map((c) => c.configDir))], [flagDir], "every claude call must be pinned to the --claude-home dir");
    assert.ok(existsSync(cacheDir(flagDir)));
    assert.ok(!existsSync(join(envDir, "plugins")), "the env dir must be untouched");
  } finally {
    cleanup(sb);
  }
});

test("with CLAUDE_CONFIG_DIR unset the default ~/.claude is the target, and a real `claude` on PATH is found without the seam", { skip }, () => {
  const sb = sandbox();
  claudeOnPath(sb);
  try {
    const r = run(sb, ["install", "wicked-garden"], { claude: "path" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const expected = join(sb.home, ".claude");
    assert.deepEqual([...new Set(jsonLines(sb.stubLog).map((c) => c.configDir))], [expected]);
    assert.ok(existsSync(cacheDir(expected)));
    assert.match(r.stdout, new RegExp(`probe: ${escapeRe(join(sb.bin, "claude"))} --version`), "the PATH binary, not the seam");
  } finally {
    cleanup(sb);
  }
});

test("a set-but-empty CLAUDE_CONFIG_DIR is an error (exit 1, nothing registered), not a fall-through to ~/.claude", { skip }, () => {
  const sb = sandbox();
  try {
    for (const bad of ["", " ", ":", ","]) {
      const r = run(sb, ["install", "wicked-garden"], { configDir: bad });
      assert.equal(r.status, 1, `CLAUDE_CONFIG_DIR=${JSON.stringify(bad)}:\n${r.stdout}`);
      assert.match(r.stdout + r.stderr, /CLAUDE_CONFIG_DIR is set but names no directory/);
      assert.deepEqual(lines(sb.npmLog), [], "the dependency (wicked-vault) is NOT installed before the config dir is validated");
    }
    assert.ok(!existsSync(join(sb.home, ".claude")), "~/.claude was never touched");
    assert.ok(!existsSync(sb.stubLog), "claude was never invoked");
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

test("an invalid --source-root is rejected before any dependency is installed", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  const bogus = join(sb.tmp, "not-a-checkout");
  mkdirSync(cfg);
  mkdirSync(bogus);
  try {
    const r = run(sb, ["install", "wicked-garden", "--source-root", bogus], { configDir: cfg });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no \.claude-plugin\/marketplace\.json under/);
    assert.deepEqual(lines(sb.npmLog), [], "wicked-vault must NOT have been installed on an invalid invocation");
    assert.ok(!existsSync(sb.stubLog), "claude never invoked");
    assert.ok(!existsSync(join(cfg, "plugins")));
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
  writeFileSync(join(root, "wicked-garden", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "wicked-garden" }));
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

test("without any Claude Code the installer falls back to the bare copy and says it is unregistered", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, claude: false });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault", "npx wicked-garden install"]);
    assert.ok(!existsSync(sb.stubLog), "no claude calls when it is absent");
    assert.match(r.stdout, /Claude Code CLI not detected on PATH; falling back to npx wicked-garden install/);
    assert.match(r.stdout, new RegExp(`copied to ${escapeRe(join(sb.home, ".claude", "plugins", "wicked-garden"))} via npx wicked-garden install; not registered — Claude Code not detected`));
  } finally {
    cleanup(sb);
  }
});

test("a PRESENT but broken Claude Code (`--version` fails) is an install error, never a fallback", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, env: { CLAUDE_STUB_FAIL: "version" } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-stub\.mjs --version failed \(exit 1\): stub: claude is broken — Claude Code is present but not working/);
    assert.deepEqual(calls(sb).map(([, argv]) => argv), ["--version"], "nothing beyond the probe runs");
    assert.deepEqual(lines(sb.npmLog), ["npm install -g wicked-vault"], "no npx fallback");
    assert.ok(!existsSync(join(cfg, "plugins")));
  } finally {
    cleanup(sb);
  }
});

test("a failing install after THIS run's marketplace add rolls the add back (marketplace remove) and fails the install", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, env: { CLAUDE_STUB_FAIL: "install" } });
    assert.equal(r.status, 1, "exit 1 on a failed registration");
    // add/install/update run with inherited stdio so Claude Code's own progress (and any consent
    // prompt it raises) reaches the user directly — so the CLI's stderr is on OUR stderr, and the
    // installer's message carries the rendered command + exit code.
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(cfg)} claude plugin install wicked-garden@wicked-garden failed \\(exit 1\\)`));
    assert.match(r.stderr, /stub: plugin install failed/);
    assert.match(r.stdout, /1 installation\(s\) failed/);
    assert.ok(!existsSync(cacheDir(cfg)), "nothing claims to be installed");
    // The marketplace this run added is removed again — no half-registration left behind.
    assert.deepEqual(calls(sb).map(([, argv]) => argv), [
      "--version",
      "plugin marketplace add mikeparcewski/wicked-garden",
      "plugin install wicked-garden@wicked-garden",
      "plugin marketplace remove wicked-garden",
    ]);
    assert.match(r.stdout, new RegExp(`rolled back this run's marketplace add: CLAUDE_CONFIG_DIR=${escapeRe(cfg)} claude plugin marketplace remove wicked-garden`));
    const known = JSON.parse(readFileSync(join(cfg, "plugins", "known_marketplaces.json"), "utf8"));
    assert.ok(!("wicked-garden" in known), "known_marketplaces.json no longer lists the marketplace");
  } finally {
    cleanup(sb);
  }
});

test("a failing install does NOT remove a marketplace that was already registered before this run", { skip }, () => {
  const sb = sandbox();
  const cfg = join(sb.tmp, "cfg");
  mkdirSync(cfg);
  try {
    assert.equal(run(sb, ["install", "wicked-garden"], { configDir: cfg }).status, 0);
    rmSync(cacheDir(cfg), { recursive: true, force: true }); // make the next run an `install` (repair)
    rmSync(sb.stubLog);
    const r = run(sb, ["install", "wicked-garden"], { configDir: cfg, env: { CLAUDE_STUB_FAIL: "install" } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(calls(sb).map(([, argv]) => argv), ["--version", "plugin install wicked-garden@wicked-garden"], "no add this run ⇒ no remove");
    const known = JSON.parse(readFileSync(join(cfg, "plugins", "known_marketplaces.json"), "utf8"));
    assert.ok("wicked-garden" in known, "the pre-existing marketplace registration is kept");
  } finally {
    cleanup(sb);
  }
});

test("status: per-dir verdict (registered / partial / copy only / not installed), the product list agrees, and the ONLY claude invocation is the read-only `--version` probe", { skip }, () => {
  const sb = sandbox();
  claudeOnPath(sb);
  const registered = join(sb.tmp, "cfg-registered");
  const bare = join(sb.tmp, "cfg-bare");
  const empty = join(sb.tmp, "cfg-empty");
  const partial = join(sb.tmp, "cfg-partial");
  mkdirSync(registered);
  mkdirSync(join(bare, "plugins", "wicked-garden", ".claude-plugin"), { recursive: true });
  writeFileSync(join(bare, "plugins", "wicked-garden", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "12.0.0" }));
  mkdirSync(empty);
  // A leftover install record with no marketplace entry and no payload on disk.
  mkdirSync(join(partial, "plugins"), { recursive: true });
  writeFileSync(join(partial, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: cacheDir(partial, "9.9.9"), version: "9.9.9" }] },
  }));
  try {
    assert.equal(run(sb, ["install", "wicked-garden"], { configDir: registered }).status, 0);
    const statusLog = join(sb.tmp, "status-stub.log");
    const status = (dir, args = []) => run(sb, ["status", ...args], { configDir: dir, claude: "path", env: { CLAUDE_STUB_LOG: statusLog } });

    const a = status(registered);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /Detected CLIs:[\s\S]*Claude Code \(9\.9\.9 \(Claude Code stub\)\)/, "CLI detection sees the PATH stub");
    assert.match(a.stdout, /Claude Code plugin registration \(wicked-garden@wicked-garden\)/);
    assert.match(a.stdout, /marketplace: wicked-garden ← github:mikeparcewski\/wicked-garden/);
    assert.match(a.stdout, /installed:\s+0\.0\.1-stub \(user\)/);
    assert.match(a.stdout, /cache:\s+0\.0\.1-stub/);
    assert.match(a.stdout, /state:\s+✓ registered/);
    assert.match(a.stdout, /overall:\s+registered across 1 config dir\(s\)/);
    assert.match(a.stdout, /✓ installed\s+wicked-garden/, "the product list counts a registration as installed");

    // Anything short of registered in every active dir exits 1.
    const b = status(bare);
    assert.equal(b.status, 1, b.stdout + b.stderr);
    assert.match(b.stdout, /marketplace: not registered/);
    assert.match(b.stdout, /installed:\s+not installed/);
    assert.match(b.stdout, /bare copy:\s+.*plugins[\\/]wicked-garden \(v12\.0\.0\) — copy only \(unregistered\).*left in place \(https:\/\/github\.com\/mikeparcewski\/wicked-installer\/issues\/20\)/);
    assert.match(b.stdout, /state:\s+~ copy only \(unregistered\)/);
    assert.match(b.stdout, /overall:\s+copy only \(unregistered\) across 1 config dir\(s\)/);
    assert.match(b.stdout, /not installed\s+wicked-garden/, "a bare copy is not 'installed' in the product list: Claude Code cannot load it");

    const c = status(empty);
    assert.equal(c.status, 1, c.stdout + c.stderr);
    assert.match(c.stdout, /state:\s+not installed/);
    assert.match(c.stdout, /overall:\s+not installed across 1 config dir\(s\)/);
    assert.match(c.stdout, /not installed\s+wicked-garden/);

    const e = status(partial);
    assert.equal(e.status, 1, e.stdout + e.stderr);
    assert.match(e.stdout, /installed:\s+9\.9\.9 \(user\)/);
    assert.match(e.stdout, /state:\s+✗ partially registered \(marketplace entry missing from known_marketplaces\.json; payload dir missing: .*9\.9\.9 \(user scope\)\)/);
    assert.match(e.stdout, /not installed\s+wicked-garden/, "a stale record is not 'installed' in the product list either");

    // --claude-home works for status too, and detection follows the same target set.
    const d = status(empty, ["--claude-home", registered]);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /from --claude-home/);
    assert.match(d.stdout, /state:\s+✓ registered/);
    assert.match(d.stdout, /✓ installed\s+wicked-garden/);

    // Two active dirs: the aggregate is the WORST state (registered + partial ⇒ partial), exit 1,
    // and the product list agrees (installed means registered everywhere).
    const two = status(`${registered}:${partial}`);
    assert.equal(two.status, 1, two.stdout + two.stderr);
    assert.match(two.stdout, /state:\s+✓ registered/);
    assert.match(two.stdout, /state:\s+✗ partially registered/);
    assert.match(two.stdout, /overall:\s+partially registered across 2 config dir\(s\)/);
    assert.match(two.stdout, /not installed\s+wicked-garden/);

    // Exactly which claude invocations `status` made: one `--version` per run (CLI detection),
    // and never a `claude plugin …` command.
    const statusCalls = jsonLines(statusLog).map((x) => x.argv.join(" "));
    assert.deepEqual(statusCalls, ["--version", "--version", "--version", "--version", "--version", "--version"]);
  } finally {
    cleanup(sb);
  }
});

test("status: an unreadable registration (symlinked or unreadable state file) is an ERROR — exit 1, reported as such, never 'not installed'", { skip }, () => {
  const sb = sandbox();
  const linked = join(sb.tmp, "cfg-linked");
  const denied = join(sb.tmp, "cfg-denied");
  mkdirSync(join(linked, "plugins"), { recursive: true });
  writeFileSync(join(linked, "plugins", "real.json"), JSON.stringify({ version: 2, plugins: {} }));
  symlinkSync(join(linked, "plugins", "real.json"), join(linked, "plugins", "installed_plugins.json"));
  mkdirSync(join(denied, "plugins"), { recursive: true });
  writeFileSync(join(denied, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  chmodSync(join(denied, "plugins", "installed_plugins.json"), 0o000);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  try {
    const a = run(sb, ["status"], { configDir: linked });
    assert.equal(a.status, 1, a.stdout + a.stderr);
    assert.match(a.stdout, /state:\s+! unreadable \(.*installed_plugins\.json: is a symlink — refusing to follow it\)/);
    assert.match(a.stdout, /overall:\s+unreadable across 1 config dir\(s\)/);
    assert.doesNotMatch(a.stdout, /state:\s+not installed/);

    if (!root) {
      const b = run(sb, ["status"], { configDir: denied });
      assert.equal(b.status, 1, b.stdout + b.stderr);
      assert.match(b.stdout, /state:\s+! unreadable \(.*installed_plugins\.json: EACCES\)/);
    }
  } finally {
    chmodSync(join(denied, "plugins", "installed_plugins.json"), 0o644);
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
    assert.equal(r.status, 1, "an empty active dir is not registered ⇒ exit 1");
    assert.match(r.stdout, /is not an active config dir but holds a bare copy at .*plugins[\\/]wicked-garden \(v11\.0\.0\) — copy only \(unregistered\).*left in place \(https:\/\/github\.com\/mikeparcewski\/wicked-installer\/issues\/20\)/);

    // Installing into the active dir reports the legacy copy and leaves it exactly where it was.
    const i = run(sb, ["install", "wicked-garden"], { configDir: cfg });
    assert.equal(i.status, 0, i.stdout + i.stderr);
    assert.match(i.stdout, new RegExp(`legacy wicked-garden copy detected at ${escapeRe(join(sb.home, ".claude", "plugins", "wicked-garden"))} — left in place; removal will ship separately \\(see https://github\\.com/mikeparcewski/wicked-installer/issues/20\\)`));
    assert.match(i.stdout, /1 legacy copy left in place/);
    assert.equal(readFileSync(join(legacy, "plugin.json"), "utf8"), JSON.stringify({ name: "wicked-garden", version: "11.0.0" }), "the legacy copy is untouched");
  } finally {
    cleanup(sb);
  }
});
