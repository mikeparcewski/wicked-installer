// No fixture executable is ever run: detection is a file probe and installs use the run seam.
// Isolate every location, including the legacy cargo dirs, so the developer's uv cannot leak in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const { findUv, uvInstallCommand, ensureUv } = await import("../dist/uv.js");
const { pathFix, exeName } = await import("../dist/release-binary.js");
const CURL = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const WGET = "wget -qO- https://astral.sh/uv/install.sh | sh";
const POWERSHELL = 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"';
const command = process.platform === "win32" ? POWERSHELL : CURL;
const instruction = `wicked-crew needs uv: its daemon builds the skills environment every job uses with uv. Install it with: ${command}  (https://docs.astral.sh/uv/getting-started/installation/), then run the installer again.`;

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "wicked-uv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const env = { PATH: bin, HOME: home, USERPROFILE: home, CARGO_HOME: join(root, "cargo") };
  const fake = (dir, name = "uv", platform = process.platform) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, exeName(name, platform));
    writeFileSync(path, "fixture: never execute\n", { mode: 0o755 });
    return path;
  };
  const opts = { env, home, needed: true, dryRun: false, offline: false, run: () => assert.fail("installer must not run") };
  return { root, home, bin, env, fake, opts };
}

test("findUv prefers PATH over Astral and legacy locations", (t) => {
  const sb = sandbox(t);
  sb.env.UV_INSTALL_DIR = join(sb.root, "astral");
  sb.fake(sb.env.UV_INSTALL_DIR);
  sb.fake(join(sb.home, ".local", "bin"));
  const path = sb.fake(sb.bin);
  assert.deepEqual(findUv(sb.opts), { path, onPath: true });
});

test("findUv finds ~/.local/bin using the supplied environment's home", (t) => {
  const sb = sandbox(t);
  const path = sb.fake(join(sb.home, ".local", "bin"));
  assert.deepEqual(findUv({ env: sb.env }), { path, onPath: false });
});

for (const location of ["UV_INSTALL_DIR", "XDG_BIN_HOME", "legacy cargo", "CARGO_HOME"]) {
  test(`findUv finds ${location}`, (t) => {
    const sb = sandbox(t);
    const dir = location === "legacy cargo" ? join(sb.home, ".cargo", "bin")
      : location === "CARGO_HOME" ? join(sb.env.CARGO_HOME, "bin")
      : (sb.env[location] = join(sb.root, location));
    const path = sb.fake(dir);
    assert.deepEqual(findUv(sb.opts), { path, onPath: false });
  });
}

test("findUv respects Astral's directory precedence", (t) => {
  const sb = sandbox(t);
  sb.env.UV_INSTALL_DIR = join(sb.root, "astral");
  sb.env.XDG_BIN_HOME = join(sb.root, "xdg");
  sb.fake(join(sb.home, ".local", "bin"));
  sb.fake(sb.env.XDG_BIN_HOME);
  const path = sb.fake(sb.env.UV_INSTALL_DIR);
  assert.deepEqual(findUv(sb.opts), { path, onPath: false });
});

test("findUv returns undefined when missing and rejects directories", (t) => {
  const sb = sandbox(t);
  assert.equal(findUv(sb.opts), undefined);
  mkdirSync(join(sb.bin, exeName("uv")));
  assert.equal(findUv(sb.opts), undefined);
});

test("findUv rejects a non-executable POSIX file", { skip: process.platform === "win32" }, (t) => {
  const sb = sandbox(t);
  writeFileSync(join(sb.bin, "uv"), "not executable", { mode: 0o644 });
  assert.equal(findUv(sb.opts), undefined);
});

test("findUv handles Windows .exe, semicolon PATH, and USERPROFILE", (t) => {
  const sb = sandbox(t);
  const path = sb.fake(sb.bin, "uv", "win32");
  assert.deepEqual(findUv({ platform: "win32", env: { Path: `${sb.root};${sb.bin}`, USERPROFILE: sb.home } }), { path, onPath: true });
  const local = sb.fake(join(sb.home, ".local", "bin"), "uv", "win32");
  assert.deepEqual(findUv({ platform: "win32", env: { PATH: "", USERPROFILE: sb.home } }), { path: local, onPath: false });
});

test("uvInstallCommand uses the documented platform commands and wget fallback", (t) => {
  const sb = sandbox(t);
  assert.equal(uvInstallCommand("linux", sb.env), CURL);
  assert.equal(uvInstallCommand("darwin", sb.env), CURL);
  assert.equal(uvInstallCommand("win32", sb.env), POWERSHELL);
  sb.fake(sb.bin, "wget", "linux");
  assert.equal(uvInstallCommand("linux", sb.env), WGET);
  sb.fake(sb.bin, "curl", "linux");
  assert.equal(uvInstallCommand("linux", sb.env), CURL);
});

test("ensureUv is ok when not needed", async (t) => {
  const sb = sandbox(t);
  const result = await ensureUv({ ...sb.opts, needed: false, offline: true });
  assert.equal(result.ok, true);
  assert.equal(result.action, "not-needed");
});

test("ensureUv reports a present PATH executable without asking or running", async (t) => {
  const sb = sandbox(t);
  const path = sb.fake(sb.bin);
  const result = await ensureUv({ ...sb.opts, offline: true, confirm: () => assert.fail("must not ask") });
  assert.equal(result.ok, true);
  assert.equal(result.action, "present");
  assert.equal(result.path, path);
  assert.ok(result.message.includes(path));
  assert.match(result.message, /on PATH/);
});

test("ensureUv reports an off-PATH executable and the platform PATH fix", async (t) => {
  const sb = sandbox(t);
  const path = sb.fake(join(sb.home, ".local", "bin"));
  const result = await ensureUv(sb.opts);
  assert.equal(result.ok, true);
  assert.equal(result.action, "present");
  assert.equal(result.path, path);
  assert.match(result.message, /not on PATH/);
  assert.ok(result.message.includes(pathFix(dirname(path))));
});

test("ensureUv dry-run plans the command without running or asking, even offline", async (t) => {
  const sb = sandbox(t);
  const result = await ensureUv({ ...sb.opts, dryRun: true, offline: true, confirm: () => assert.fail("must not ask") });
  assert.equal(result.ok, true);
  assert.equal(result.action, "planned");
  assert.ok(result.message.includes(command));
});

test("ensureUv offline fails with the instruction without running or asking", async (t) => {
  const sb = sandbox(t);
  const result = await ensureUv({ ...sb.opts, offline: true, confirm: () => assert.fail("must not ask") });
  assert.deepEqual(result, { ok: false, action: "offline", message: instruction });
});

test("ensureUv declined fails with the instruction without running", async (t) => {
  const sb = sandbox(t);
  let asked = 0;
  const result = await ensureUv({ ...sb.opts, confirm: async () => { asked += 1; return false; } });
  assert.equal(asked, 1);
  assert.deepEqual(result, { ok: false, action: "declined", message: instruction });
});

for (const interactive of [false, true]) {
  test(`ensureUv re-detects a successful install (${interactive ? "confirmed" : "non-interactive"})`, async (t) => {
    const sb = sandbox(t);
    let asked = false;
    let calls = 0;
    const logs = [];
    const path = join(sb.home, ".local", "bin", exeName("uv"));
    const result = await ensureUv({
      ...sb.opts,
      ...(interactive ? { confirm: async () => { asked = true; return true; } } : {}),
      log: (line) => logs.push(line),
      run: (cmd, platform) => {
        calls += 1;
        assert.equal(asked, interactive);
        assert.equal(cmd, command);
        assert.equal(platform, process.platform);
        sb.fake(dirname(path));
        return { status: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.action, "installed");
    assert.equal(result.path, path);
    assert.ok(result.message.includes(path));
    // astral's installer edits the shell profile itself: the message says open a new terminal,
    // not "add it to PATH" (seen live: it wrote .zshrc and .profile).
    assert.match(result.message, /open a new terminal/);
    assert.ok(!result.message.includes(pathFix(dirname(path))));
    assert.ok(logs.some((line) => line.includes(command)));
  });
}

for (const scenario of ["exit 0 without binary", "exit 1 with binary", "spawn error", "throw"]) {
  test(`ensureUv fails with the instruction after ${scenario}`, async (t) => {
    const sb = sandbox(t);
    const result = await ensureUv({ ...sb.opts, run: () => {
      if (scenario === "throw") throw new Error("spawn failed");
      if (scenario === "exit 1 with binary") sb.fake(sb.bin);
      return scenario === "spawn error" ? { status: null, error: "ENOENT" }
        : { status: scenario === "exit 0 without binary" ? 0 : 1 };
    } });
    assert.deepEqual(result, { ok: false, action: "failed", message: instruction });
  });
}

test("install of a product requiring crew stops offline before installing any dependency", (t) => {
  const sb = sandbox(t);
  const env = { ...process.env, ...sb.env, UV_INSTALL_DIR: "", XDG_BIN_HOME: "" };
  delete env.CLAUDE_CONFIG_DIR;
  const result = spawnSync(process.execPath, ["dist/index.js", "install", "wicked-core", "--offline"], { env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(instruction));
  assert.doesNotMatch(result.stdout, /Adding required dependencies|Installing|→/);
});

test("dispatch returns 1 before launching any per-CLI script when uv is absent offline", (t) => {
  const sb = sandbox(t);
  const env = { ...process.env, ...sb.env, UV_INSTALL_DIR: "", XDG_BIN_HOME: "" };
  const script = `
    import { dispatchToClis } from "./dist/index.js";
    process.exitCode = await dispatchToClis(
      [{ cli: "codex", displayName: "Codex", scriptPath: "must-not-run.mjs" }],
      ["wicked-crew"],
      { dryRun: false, force: false, claudeHomes: [], offline: true, interactive: true },
    );
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(instruction));
  assert.doesNotMatch(result.stderr, /must-not-run|MODULE_NOT_FOUND/);
  assert.doesNotMatch(result.stdout, /Installing into/);
});
