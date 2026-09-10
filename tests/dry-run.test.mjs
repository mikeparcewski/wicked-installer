// dry-run.test.mjs — `--dry-run` must be DRY for every product type (#18).
//
// Before this, `install wicked-garden --dry-run` ran `npm install -g wicked-vault` and garden's real
// install.mjs: the direct install path never looked at the flag. These tests prove the plan is printed
// and nothing that writes runs. Two independent witnesses:
//   1. spawn-guard.cjs (a --require preload) replaces every child_process entry point and global
//      fetch: the ONE read-only probe a dry run may make — `claude --version`, verified to write
//      nothing — is recorded and passed through; anything else is recorded and throws, so any other
//      spawn fails the run AND leaves its argv in the guard log;
//   2. the temp HOME/config tree is snapshotted before and after and must be byte-for-byte the same.
// The plan itself is asserted per install type against a FAKE registry (one product per type), so
// a new arm that forgets the flag fails here rather than on someone's machine.
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const GUARD = join(__dirname, "spawn-guard.cjs");
const WIN = process.platform === "win32";

function product(id, type, install, requires = []) {
  return { id, displayName: id, description: id, type, standalone: true, opinionated: false, status: "stable", requires, install };
}

/** One product per install type, plus a claude-plugin that depends on another product. */
const FAKE_REGISTRY = {
  version: "1",
  products: [
    product("fake-npm-global", "npm-lib", { type: "npm-global", package: "fake-global-pkg" }),
    product("fake-npm-run", "npm-cli", { type: "npm-run", package: "fake-run-pkg", command: "install", args: ["--flag"] }),
    product("fake-cargo", "mcp-binary", { type: "cargo", crates: ["fake-crate", "fake-crate-mcp"], crate: "fake-crate-mcp" }),
    product("fake-gh", "mcp-binary", { type: "github-binary", githubRepo: "acme/fake-gh" }),
    product("fake-git", "npm-lib", { type: "git-plugin", repo: "https://example.invalid/acme/fake-git.git" }),
    product("fake-manual", "desktop-binary", { type: "manual", instructions: "download it from the fake site" }),
    product("fake-binary", "desktop-binary", { type: "binary", instructions: "grab the fake binary" }),
    product(
      "fake-plugin",
      "claude-plugin",
      { type: "npm-run", package: "fake-plugin-pkg", command: "install", marketplace: "acme/fake-plugin", pluginId: "fake-plugin@fake-plugin" },
      ["fake-npm-global"],
    ),
  ],
  bundles: [],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A self-contained copy of dist/ with its own registry + package.json (index.js reads both from
 * `..`), node_modules linked from the repo, a temp HOME holding a Claude config dir, and a PATH
 * that contains only node's directory plus an optional `claude`: "ok" answers --version and exits
 * 0 (it is never invoked with anything else — the guard would throw); "broken" exits 99.
 */
function sandbox({ withClaude = "ok", registry = FAKE_REGISTRY } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-dry-run-"));
  cpSync(join(ROOT, "dist"), join(tmp, "dist"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"), WIN ? "junction" : "dir");
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(join(tmp, "registry.json"), JSON.stringify(registry, null, 2));

  const home = join(tmp, "home");
  const cfg = join(home, "cfg");
  const bin = join(tmp, "bin");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(cfg, "settings.json"), "{}");
  if (withClaude) {
    const body = withClaude === "ok"
      ? (WIN ? "@echo off\r\necho 9.9.9 (fake claude)\r\nexit /b 0\r\n" : "#!/bin/sh\necho '9.9.9 (fake claude)'\nexit 0\n")
      : (WIN ? "@echo off\r\necho fake claude is broken 1>&2\r\nexit /b 99\r\n" : "#!/bin/sh\necho 'fake claude is broken' >&2\nexit 99\n");
    writeFileSync(join(bin, WIN ? "claude.cmd" : "claude"), body, { mode: 0o755 });
  }
  return { tmp, home, cfg, bin, cli: join(tmp, "dist", "index.js") };
}

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

function runDry(sb, args, { env: extraEnv = {}, unsetConfigDir = false } = {}) {
  const guardLog = join(sb.tmp, "spawn-guard.log");
  const env = {
    ...process.env,
    HOME: sb.home,
    USERPROFILE: sb.home,
    CLAUDE_CONFIG_DIR: sb.cfg,
    PATH: `${sb.bin}${WIN ? ";" : ":"}${dirname(process.execPath)}`,
    SPAWN_GUARD_LOG: guardLog,
    NODE_OPTIONS: "",
    ...extraEnv,
  };
  delete env.WICKED_CLAUDE_BIN;
  if (unsetConfigDir) delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, ["--require", GUARD, sb.cli, "install", ...args, "--dry-run"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { ...r, guardLog };
}

const guardEntries = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function cleanup(sb) {
  rmSync(sb.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The dry-run contract: exit 0, only allow-listed `claude --version` probes spawned, no writes. */
function assertDry(sb, r, before, { probes }) {
  assert.equal(r.status, 0, `a dry run must exit 0:\n${r.stdout}\n${r.stderr}`);
  assertOnlyProbes(r, probes);
  assert.deepEqual(snapshot(sb.home), before, "a dry run must write nothing under HOME");
  assert.match(r.stdout, /Dry run complete — nothing was installed or written/);
}

function assertOnlyProbes(r, probes) {
  const entries = guardEntries(r.guardLog);
  const disallowed = entries.filter((e) => !e.allowed);
  assert.deepEqual(disallowed, [], `a dry run may spawn nothing but \`claude --version\`, but the guard recorded:\n${JSON.stringify(disallowed, null, 2)}`);
  for (const e of entries) assert.deepEqual(e.args.slice(-1), ["--version"], JSON.stringify(e));
  if (probes) assert.ok(entries.length > 0, "with claude present the plan is derived from a real `claude --version` probe");
  else assert.equal(entries.length, 0, "with no claude on PATH nothing at all is spawned");
}

test("--dry-run spawns nothing but the version probe and writes nothing, for ANY install type (claude present)", () => {
  const sb = sandbox();
  try {
    const before = snapshot(sb.home);
    const ids = FAKE_REGISTRY.products.map((p) => p.id);
    const r = runDry(sb, ids);
    assertDry(sb, r, before, { probes: true });

    const out = r.stdout;
    assert.match(out, /dry-run: npm install -g fake-global-pkg/);
    assert.match(out, /dry-run: npx fake-run-pkg install --flag/);
    assert.match(out, /dry-run: cargo install fake-crate fake-crate-mcp/);
    assert.match(out, /dry-run: GET https:\/\/api\.github\.com\/repos\/acme\/fake-gh\/releases\/latest/);
    assert.match(out, /dry-run: git clone --depth 1 https:\/\/example\.invalid\/acme\/fake-git\.git/);
    assert.match(out, /download it from the fake site/, "manual instructions still surface in a dry run");
    assert.match(out, /grab the fake binary/);

    // The claude-plugin product: probes first, then a REGISTRATION plan pinned to the active
    // config dir — exactly the commands a live run would execute, nothing more.
    const cfg = escapeRe(sb.cfg);
    assert.match(out, /probe: .*claude(\.cmd)? --version → 9\.9\.9 \(fake claude\)/);
    assert.match(out, new RegExp(`probe:\\s+${cfg}[\\\\/]plugins[\\\\/]known_marketplaces\\.json → marketplace fake-plugin: not registered`));
    assert.match(out, new RegExp(`probe:\\s+${cfg}[\\\\/]plugins[\\\\/]installed_plugins\\.json → fake-plugin@fake-plugin: not installed`));
    assert.match(out, new RegExp(`dry-run:\\s+CLAUDE_CONFIG_DIR=${cfg} claude plugin marketplace add acme/fake-plugin\\s+\\(marketplace not registered\\)`));
    assert.match(out, new RegExp(`dry-run:\\s+CLAUDE_CONFIG_DIR=${cfg} claude plugin install fake-plugin@fake-plugin\\s+\\(not installed\\)`));
    assert.match(out, new RegExp(`${cfg}[\\\\/]plugins[\\\\/]cache[\\\\/]fake-plugin[\\\\/]fake-plugin[\\\\/]<version>`));
    assert.doesNotMatch(out, /dry-run: npx fake-plugin-pkg install/, "with Claude Code present the bare-copy fallback is not the plan");
    assert.doesNotMatch(out, /failed/i);
  } finally {
    cleanup(sb);
  }
});

test("--dry-run without Claude Code spawns nothing and plans the bare-copy fallback, saying it is unregistered", () => {
  const sb = sandbox({ withClaude: false });
  try {
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin"]);
    assertDry(sb, r, before, { probes: false });
    assert.match(r.stdout, /Claude Code CLI not detected/);
    assert.match(r.stdout, /dry-run: npx fake-plugin-pkg install/);
    assert.match(r.stdout, /not registered/);
    assert.doesNotMatch(r.stdout, /claude plugin marketplace add/);
    assert.match(r.stdout, /dry-run: npm install -g fake-global-pkg/, "the dependency's plan is printed too (deps first)");
  } finally {
    cleanup(sb);
  }
});

test("--dry-run with a PRESENT but broken Claude Code fails (exit 1) instead of pretending it is absent", () => {
  const sb = sandbox({ withClaude: "broken" });
  try {
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin"]);
    assert.equal(r.status, 1, `a broken claude must fail the run:\n${r.stdout}`);
    assert.match(r.stdout, /--version failed \(exit 99\): fake claude is broken — Claude Code is present but not working/);
    assert.doesNotMatch(r.stdout, /dry-run: npx fake-plugin-pkg install/, "a broken Claude Code is never a licence to fall back to the bare copy");
    assertOnlyProbes(r, true);
    assert.deepEqual(snapshot(sb.home), before, "still no writes");
  } finally {
    cleanup(sb);
  }
});

test("--claude-home wins over CLAUDE_CONFIG_DIR, is repeatable, and its values are not product ids", () => {
  const sb = sandbox();
  try {
    const a = join(sb.tmp, "home-a");
    const b = join(sb.tmp, "home-b");
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin", "--claude-home", a, `--claude-home=${b}`]);
    assertDry(sb, r, before, { probes: true });
    assert.doesNotMatch(r.stdout, /Unknown products/, "flag values must not be parsed as product ids");
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(a)} claude plugin install fake-plugin@fake-plugin`));
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(b)} claude plugin install fake-plugin@fake-plugin`));
    assert.doesNotMatch(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(sb.cfg)} `), "--claude-home replaces the env-derived set");
    assert.match(r.stdout, /from --claude-home/);
    assert.ok(!existsSync(a) && !existsSync(b), "a dry run must not create the target dirs");
  } finally {
    cleanup(sb);
  }
});

test("--dry-run renders a config dir with spaces, `$` and `&` quoted for the shell (and probes it correctly)", () => {
  const sb = sandbox();
  try {
    const weird = join(sb.home, "cfg with space$and&amp");
    mkdirSync(weird);
    writeFileSync(join(weird, "settings.json"), "{}");
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin"], { env: { CLAUDE_CONFIG_DIR: weird } });
    assertDry(sb, r, before, { probes: true });
    // POSIX: single-quoted env assignment; cmd.exe: `set "VAR=value" && …`.
    const expected = WIN
      ? `set "CLAUDE_CONFIG_DIR=${weird}" && claude plugin install fake-plugin@fake-plugin`
      : `CLAUDE_CONFIG_DIR='${weird}' claude plugin install fake-plugin@fake-plugin`;
    assert.ok(r.stdout.includes(expected), r.stdout);
    assert.ok(!r.stdout.includes(`CLAUDE_CONFIG_DIR=${weird} claude`), "the raw, unquoted POSIX form is never printed");
    assert.match(r.stdout, /probe:\s+.*cfg with space\$and&amp[\\/]plugins[\\/]known_marketplaces\.json → marketplace fake-plugin: not registered/);
  } finally {
    cleanup(sb);
  }
});

test("an UNSET CLAUDE_CONFIG_DIR means ~/.claude; a set-but-empty one is an error, not a silent fall-through", () => {
  const sb = sandbox();
  try {
    const before = snapshot(sb.home);
    const unset = runDry(sb, ["fake-plugin"], { unsetConfigDir: true });
    assertDry(sb, unset, before, { probes: true });
    assert.match(unset.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(join(sb.home, ".claude"))} claude plugin install fake-plugin@fake-plugin`));
    assert.match(unset.stdout, /from default ~\/\.claude/);

    for (const bad of ["", "   ", ":", ",", " : , "]) {
      rmSync(unset.guardLog, { force: true }); // the guard log is per sandbox; judge each run on its own spawns
      const r = runDry(sb, ["fake-plugin"], { env: { CLAUDE_CONFIG_DIR: bad } });
      assert.equal(r.status, 1, `CLAUDE_CONFIG_DIR=${JSON.stringify(bad)} must fail:\n${r.stdout}`);
      assert.match(r.stdout, /CLAUDE_CONFIG_DIR is set but names no directory/);
      assert.doesNotMatch(r.stdout, /claude plugin (install|marketplace add)/, "no plan is produced for a misconfigured env");
      assert.deepEqual(guardEntries(r.guardLog), [], "nothing is spawned before the misconfiguration is rejected");
      assert.deepEqual(snapshot(sb.home), before, "and nothing is written");
    }
  } finally {
    cleanup(sb);
  }
});

test("--dry-run reads the existing registration: no `marketplace add` when present, `update` for a healthy install, `install` to repair a partial one", () => {
  const sb = sandbox();
  try {
    const pluginsDir = join(sb.cfg, "plugins");
    const installPath = join(pluginsDir, "cache", "fake-plugin", "fake-plugin", "1.2.3");
    mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fake-plugin", version: "1.2.3" }));
    writeFileSync(join(pluginsDir, "known_marketplaces.json"), JSON.stringify({
      "fake-plugin": { source: { source: "github", repo: "acme/fake-plugin" }, installLocation: join(pluginsDir, "marketplaces", "fake-plugin"), lastUpdated: "2026-01-01T00:00:00.000Z" },
    }));
    writeFileSync(join(pluginsDir, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "fake-plugin@fake-plugin": [{ scope: "user", installPath, version: "1.2.3" }] },
    }));
    let before = snapshot(sb.home);
    let r = runDry(sb, ["fake-plugin"]);
    assertDry(sb, r, before, { probes: true });
    assert.match(r.stdout, /probe:\s+.*known_marketplaces\.json → marketplace fake-plugin: registered \(github:acme\/fake-plugin\)/);
    assert.match(r.stdout, /probe:\s+.*installed_plugins\.json → fake-plugin@fake-plugin: 1\.2\.3 \(user\)/);
    assert.doesNotMatch(r.stdout, /claude plugin marketplace add/, "an already-registered marketplace is not re-added");
    assert.match(r.stdout, /dry-run:\s+CLAUDE_CONFIG_DIR=.* claude plugin update fake-plugin@fake-plugin\s+\(installed 1\.2\.3 \(user\)\)/);
    assert.doesNotMatch(r.stdout, /claude plugin install fake-plugin@fake-plugin/);

    // Payload gone ⇒ partial ⇒ the plan is `install` (repair), and says why.
    rmSync(installPath, { recursive: true, force: true });
    before = snapshot(sb.home);
    r = runDry(sb, ["fake-plugin"]);
    assertDry(sb, r, before, { probes: true });
    assert.match(r.stdout, /dry-run:\s+CLAUDE_CONFIG_DIR=.* claude plugin install fake-plugin@fake-plugin\s+\(install record present but user scope: payload dir missing/);
    assert.doesNotMatch(r.stdout, /claude plugin update/);
  } finally {
    cleanup(sb);
  }
});

test("--dry-run fails fast on a --source-root with no marketplace manifest (and still writes nothing)", () => {
  const sb = sandbox();
  try {
    const before = snapshot(sb.home);
    const bogus = join(sb.tmp, "not-a-checkout");
    mkdirSync(bogus);
    const r = runDry(sb, ["fake-plugin", "--source-root", bogus]);
    assert.equal(r.status, 1, `a bad --source-root must fail the dry run:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no \.claude-plugin\/marketplace\.json under/);
    assert.doesNotMatch(r.stdout, /dry-run: npm install -g fake-global-pkg/, "the root is validated before the dependency is even planned");
    assert.deepEqual(guardEntries(r.guardLog), [], "the root is validated before anything is probed");
    assert.deepEqual(snapshot(sb.home), before, "still no writes");
  } finally {
    cleanup(sb);
  }
});

test("--dry-run with a valid --source-root but no Claude Code fails instead of planning the remote npx fallback", () => {
  // The npx fallback would install the PUBLISHED package — not the checkout --source-root named.
  const sb = sandbox({ withClaude: false });
  try {
    const root = join(sb.tmp, "checkouts");
    mkdirSync(join(root, "fake-plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "fake-plugin", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "fake-plugin" }));
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin", "--source-root", root]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /--source-root .* has no fallback/);
    // The refusal names the command it is NOT running; only a `dry-run:` line would be a plan to run it.
    assert.doesNotMatch(r.stdout, /dry-run: npx fake-plugin-pkg install/, "no silent fallback to the published package");
    assert.deepEqual(guardEntries(r.guardLog), [], "still no spawns");
    assert.deepEqual(snapshot(sb.home), before, "still no writes");
  } finally {
    cleanup(sb);
  }
});

test("the shipped registry: `install wicked-garden --dry-run` plans vault + registration and runs only the probe", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const sb = sandbox({ registry });
  try {
    const before = snapshot(sb.home);
    const r = runDry(sb, ["wicked-garden"]);
    assertDry(sb, r, before, { probes: true });
    assert.match(r.stdout, /Adding required dependencies: Wicked Vault/);
    assert.match(r.stdout, /dry-run: npm install -g wicked-vault/);
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(sb.cfg)} claude plugin marketplace add mikeparcewski/wicked-garden`));
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(sb.cfg)} claude plugin install wicked-garden@wicked-garden`));
    assert.doesNotMatch(r.stdout, /npx wicked-garden install/, "garden's install.mjs must not be the plan when Claude Code is present");
  } finally {
    cleanup(sb);
  }
});

test("the guard itself trips on a non-probe spawn and passes `claude --version` through (so a passing dry-run test is not vacuous)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wicked-guard-"));
  const log = join(dir, "guard.log");
  try {
    const blocked = spawnSync(
      process.execPath,
      ["--require", GUARD, "--input-type=module", "-e", "import { execa } from 'execa'; await execa('node', ['--version']);"],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env, SPAWN_GUARD_LOG: log, NODE_OPTIONS: "" }, timeout: 30_000 },
    );
    assert.notEqual(blocked.status, 0, "a guarded spawn must fail");
    assert.deepEqual(guardEntries(log).map((e) => [e.cmd, e.allowed]), [["node", false]]);

    rmSync(log, { force: true });
    const allowed = spawnSync(
      process.execPath,
      ["--require", GUARD, "--input-type=module", "-e",
        "import { spawnSync } from 'node:child_process'; const r = spawnSync(process.execPath, [process.argv[1], '--version'], { encoding: 'utf8' }); process.stdout.write(r.stdout);",
        join(__dirname, "claude-stub.mjs")],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env, SPAWN_GUARD_LOG: log, NODE_OPTIONS: "" }, timeout: 30_000 },
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /9\.9\.9 \(Claude Code stub\)/, "the allowed probe really ran");
    assert.deepEqual(guardEntries(log).map((e) => e.allowed), [true]);

    // The allow-list is an EXACT basename match: a look-alike executable or a node script that
    // merely contains "claude" in its name is blocked before it can run.
    for (const [cmd, args] of [
      ["evil-claude", ["--version"]],
      ["/tmp/claude-writer", ["--version"]],
      [process.execPath, ["/tmp/claude-writer.mjs", "--version"]],
      [process.execPath, [join(__dirname, "claude-stub.mjs"), "plugin", "list", "--json"]],
    ]) {
      rmSync(log, { force: true });
      const blocked = spawnSync(
        process.execPath,
        ["--require", GUARD, "--input-type=module", "-e",
          "import { spawnSync } from 'node:child_process'; spawnSync(process.argv[1], process.argv.slice(2));",
          cmd, ...args],
        { encoding: "utf8", cwd: ROOT, env: { ...process.env, SPAWN_GUARD_LOG: log, NODE_OPTIONS: "" }, timeout: 30_000 },
      );
      assert.notEqual(blocked.status, 0, `${cmd} ${args.join(" ")} must be blocked`);
      assert.deepEqual(guardEntries(log).map((e) => e.allowed), [false], `${cmd} ${args.join(" ")} must be recorded as disallowed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--source-root expands a leading ~ like --claude-home does (a quoted or =-joined ~ reaches the installer unexpanded)", () => {
  const sb = sandbox({ withClaude: false });
  try {
    // The checkout lives under the sandbox HOME; the flag names it through `~`.
    const root = join(sb.home, "checkouts");
    mkdirSync(join(root, "fake-plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "fake-plugin", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "fake-plugin" }));
    const before = snapshot(sb.home);
    for (const args of [["fake-plugin", "--source-root", "~/checkouts"], ["fake-plugin", "--source-root=~/checkouts"]]) {
      const r = runDry(sb, args);
      // An unexpanded ~ would be rejected as `<cwd>/~/checkouts` holding no manifest; the expanded
      // root is valid, so the run reaches the (Claude-absent) no-fallback refusal instead.
      assert.doesNotMatch(r.stdout + r.stderr, /no \.claude-plugin\/marketplace\.json under/, args.join(" "));
      assert.match(r.stdout, /--source-root .* has no fallback/, args.join(" "));
      assert.equal(r.status, 1);
    }
    // A manifest naming a different marketplace is refused up front, under the expanded path.
    writeFileSync(join(root, "fake-plugin", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "someone-elses-market" }));
    const bad = runDry(sb, ["fake-plugin", "--source-root", "~/checkouts"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout + bad.stderr, /declares marketplace "someone-elses-market", expected "fake-plugin"/);
    assert.deepEqual(guardEntries(bad.guardLog), [], "no spawns");
    // (the manifest rewrite above is the only change under HOME)
    writeFileSync(join(root, "fake-plugin", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "fake-plugin" }));
    assert.deepEqual(snapshot(sb.home), before, "no writes");
  } finally {
    cleanup(sb);
  }
});
