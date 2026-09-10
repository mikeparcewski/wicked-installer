// dry-run.test.mjs — `--dry-run` must be DRY for every product type (#18).
//
// Before this, `install wicked-garden --dry-run` ran `npm install -g wicked-vault` and garden's real
// install.mjs: the direct install path never looked at the flag. These tests prove the plan is printed
// and NOTHING runs. Two independent witnesses:
//   1. spawn-guard.cjs (a --require preload) replaces every child_process entry point and global
//      fetch with a function that records the call and throws — so any spawn fails the run AND
//      leaves its argv in the guard log;
//   2. the temp HOME/config tree is snapshotted before and after and must be byte-for-byte the same.
// The plan itself is asserted per install type against a FAKE registry (one product per type), so
// a new arm that forgets the flag fails here rather than on someone's machine.
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
 * that contains only node's directory plus an optional `claude` that exits 99 if ever executed.
 */
function sandbox({ withClaude, registry = FAKE_REGISTRY } = {}) {
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
    writeFileSync(
      join(bin, WIN ? "claude.cmd" : "claude"),
      WIN ? "@echo off\r\nexit /b 99\r\n" : "#!/bin/sh\nexit 99\n",
      { mode: 0o755 },
    );
  }
  return { tmp, home, cfg, bin, cli: join(tmp, "dist", "index.js") };
}

function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      out.push(relative(dir, f) + (e.isDirectory() ? "/" : `:${statSync(f).size}`));
      if (e.isDirectory()) walk(f);
    }
  })(dir);
  return out.sort();
}

function runDry(sb, args, extraEnv = {}) {
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
  const r = spawnSync(process.execPath, ["--require", GUARD, sb.cli, "install", ...args, "--dry-run"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { ...r, guardLog };
}

function cleanup(sb) {
  rmSync(sb.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertDry(sb, r, before) {
  assert.equal(r.status, 0, `a dry run must exit 0:\n${r.stdout}\n${r.stderr}`);
  assert.ok(
    !existsSync(r.guardLog),
    `a dry run must spawn nothing, but the guard recorded:\n${existsSync(r.guardLog) ? readFileSync(r.guardLog, "utf8") : ""}`,
  );
  assert.deepEqual(snapshot(sb.home), before, "a dry run must write nothing under HOME");
  assert.match(r.stdout, /Dry run complete — nothing was installed or written/);
}

test("--dry-run spawns nothing and writes nothing for ANY install type (claude present)", () => {
  const sb = sandbox({ withClaude: true });
  try {
    const before = snapshot(sb.home);
    const ids = FAKE_REGISTRY.products.map((p) => p.id);
    const r = runDry(sb, ids);
    assertDry(sb, r, before);

    const out = r.stdout;
    assert.match(out, /dry-run: npm install -g fake-global-pkg/);
    assert.match(out, /dry-run: npx fake-run-pkg install --flag/);
    assert.match(out, /dry-run: cargo install fake-crate fake-crate-mcp/);
    assert.match(out, /dry-run: GET https:\/\/api\.github\.com\/repos\/acme\/fake-gh\/releases\/latest/);
    assert.match(out, /dry-run: git clone --depth 1 https:\/\/example\.invalid\/acme\/fake-git\.git/);
    assert.match(out, /download it from the fake site/, "manual instructions still surface in a dry run");
    assert.match(out, /grab the fake binary/);

    // The claude-plugin product plans a REGISTRATION pinned to the active config dir, not a copy.
    const cfg = escapeRe(sb.cfg);
    assert.match(out, new RegExp(`CLAUDE_CONFIG_DIR=${cfg} claude plugin marketplace add acme/fake-plugin`));
    assert.match(out, new RegExp(`CLAUDE_CONFIG_DIR=${cfg} claude plugin install fake-plugin@fake-plugin`));
    assert.match(out, new RegExp(`${cfg}[\\\\/]plugins[\\\\/]cache[\\\\/]fake-plugin[\\\\/]fake-plugin[\\\\/]<version>`));
    assert.doesNotMatch(out, /npx fake-plugin-pkg install/, "with Claude Code present the bare-copy fallback is not the plan");
    assert.doesNotMatch(out, /failed/i);
  } finally {
    cleanup(sb);
  }
});

test("--dry-run without Claude Code plans the bare-copy fallback and says it is unregistered", () => {
  const sb = sandbox({ withClaude: false });
  try {
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin"]);
    assertDry(sb, r, before);
    assert.match(r.stdout, /Claude Code CLI not detected/);
    assert.match(r.stdout, /dry-run: npx fake-plugin-pkg install/);
    assert.match(r.stdout, /not registered/);
    assert.doesNotMatch(r.stdout, /claude plugin marketplace add/);
    // The dependency's plan is printed too (deps first).
    assert.match(r.stdout, /dry-run: npm install -g fake-global-pkg/);
  } finally {
    cleanup(sb);
  }
});

test("--claude-home wins over CLAUDE_CONFIG_DIR, is repeatable, and its values are not product ids", () => {
  const sb = sandbox({ withClaude: true });
  try {
    const a = join(sb.tmp, "home-a");
    const b = join(sb.tmp, "home-b");
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin", "--claude-home", a, `--claude-home=${b}`]);
    assertDry(sb, r, before);
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

test("--dry-run reads the existing registration and plans update/skip instead of add/install", () => {
  const sb = sandbox({ withClaude: true });
  try {
    const pluginsDir = join(sb.cfg, "plugins");
    mkdirSync(join(pluginsDir, "cache", "fake-plugin", "fake-plugin", "1.2.3"), { recursive: true });
    writeFileSync(join(pluginsDir, "known_marketplaces.json"), JSON.stringify({
      "fake-plugin": { source: { source: "github", repo: "acme/fake-plugin" }, installLocation: join(pluginsDir, "marketplaces", "fake-plugin"), lastUpdated: "2026-01-01T00:00:00.000Z" },
    }));
    writeFileSync(join(pluginsDir, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "fake-plugin@fake-plugin": [{ scope: "user", installPath: join(pluginsDir, "cache", "fake-plugin", "fake-plugin", "1.2.3"), version: "1.2.3" }] },
    }));
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin"]);
    assertDry(sb, r, before);
    assert.match(r.stdout, /marketplace add acme\/fake-plugin\s+\(skip: marketplace already registered, github:acme\/fake-plugin\)/);
    assert.match(r.stdout, /claude plugin update fake-plugin@fake-plugin\s+\(installed 1\.2\.3\)/);
    assert.doesNotMatch(r.stdout, /claude plugin install fake-plugin@fake-plugin/);
  } finally {
    cleanup(sb);
  }
});

test("--dry-run fails fast on a --source-root with no marketplace manifest (and still writes nothing)", () => {
  const sb = sandbox({ withClaude: true });
  try {
    const before = snapshot(sb.home);
    const bogus = join(sb.tmp, "not-a-checkout");
    mkdirSync(bogus);
    const r = runDry(sb, ["fake-plugin", "--source-root", bogus]);
    assert.equal(r.status, 1, `a bad --source-root must fail the dry run:\n${r.stdout}`);
    assert.match(r.stdout, /no \.claude-plugin\/marketplace\.json under/);
    assert.ok(!existsSync(r.guardLog), "still no spawns");
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
    writeFileSync(join(root, "fake-plugin", ".claude-plugin", "marketplace.json"), "{}");
    const before = snapshot(sb.home);
    const r = runDry(sb, ["fake-plugin", "--source-root", root]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /--source-root .* has no fallback/);
    // The refusal names the command it is NOT running; only a `dry-run:` line would be a plan to run it.
    assert.doesNotMatch(r.stdout, /dry-run: npx fake-plugin-pkg install/, "no silent fallback to the published package");
    assert.ok(!existsSync(r.guardLog), "still no spawns");
    assert.deepEqual(snapshot(sb.home), before, "still no writes");
  } finally {
    cleanup(sb);
  }
});

test("the shipped registry: `install wicked-garden --dry-run` plans vault + registration and runs nothing", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const sb = sandbox({ withClaude: true, registry });
  try {
    const before = snapshot(sb.home);
    const r = runDry(sb, ["wicked-garden"]);
    assertDry(sb, r, before);
    assert.match(r.stdout, /Adding required dependencies: Wicked Vault/);
    assert.match(r.stdout, /dry-run: npm install -g wicked-vault/);
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(sb.cfg)} claude plugin marketplace add mikeparcewski/wicked-garden`));
    assert.match(r.stdout, new RegExp(`CLAUDE_CONFIG_DIR=${escapeRe(sb.cfg)} claude plugin install wicked-garden@wicked-garden`));
    assert.doesNotMatch(r.stdout, /npx wicked-garden install/, "garden's install.mjs must not be the plan when Claude Code is present");
  } finally {
    cleanup(sb);
  }
});

test("the guard itself trips on a spawn (so a passing dry-run test is not vacuous)", () => {
  const log = join(mkdtempSync(join(tmpdir(), "wicked-guard-")), "guard.log");
  const r = spawnSync(
    process.execPath,
    ["--require", GUARD, "--input-type=module", "-e", "import { execa } from 'execa'; await execa('node', ['--version']);"],
    { encoding: "utf8", cwd: ROOT, env: { ...process.env, SPAWN_GUARD_LOG: log, NODE_OPTIONS: "" }, timeout: 30_000 },
  );
  try {
    assert.notEqual(r.status, 0, "a guarded spawn must fail");
    assert.ok(existsSync(log), "and be recorded");
    assert.match(readFileSync(log, "utf8"), /"cmd":"node"/);
  } finally {
    rmSync(dirname(log), { recursive: true, force: true });
  }
});
