// claude-plugin-unit.test.mjs — the pure pieces of src/claude-plugin.ts, asserted on the BUILT
// module (dist/ is what ships). Requires `npm run build` first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  claudePluginSpec,
  prepareClaudeSpawn,
  readRegistration,
  registrationVerdict,
  resolveClaudeConfigDirs,
  resolveMarketplaceSource,
} = await import(join(root, "dist", "claude-plugin.js"));

const spec = claudePluginSpec({
  id: "wicked-garden",
  install: { marketplace: "mikeparcewski/wicked-garden", pluginId: "wicked-garden@wicked-garden" },
});

test("claudePluginSpec: registry fields win, ids default to <id>@<id> / mikeparcewski/<id>", () => {
  assert.deepEqual(spec, {
    pluginId: "wicked-garden@wicked-garden",
    pluginName: "wicked-garden",
    marketplaceName: "wicked-garden",
    source: "mikeparcewski/wicked-garden",
  });
  assert.deepEqual(claudePluginSpec({ id: "acme", install: {} }), {
    pluginId: "acme@acme",
    pluginName: "acme",
    marketplaceName: "acme",
    source: "mikeparcewski/acme",
  });
});

test("prepareClaudeSpawn: a .cmd shim on win32 goes through cmd.exe with cmd-quoted args", () => {
  const p = prepareClaudeSpawn(
    "C:\\tools\\claude.cmd",
    ["plugin", "marketplace", "add", "C:\\Users\\me\\my checkout\\wicked-garden"],
    "win32",
  );
  assert.equal(p.shell, true);
  assert.deepEqual(p.argv.slice(0, 3), ["plugin", "marketplace", "add"]);
  assert.equal(p.argv[3], '"C:\\Users\\me\\my checkout\\wicked-garden"', "a path with a space is quoted for cmd.exe");
});

test("prepareClaudeSpawn: %VAR%/!VAR!-bearing args are refused for a .cmd shim rather than rewritten by cmd.exe", () => {
  // cmd.exe expands %VAR% (and !VAR! under delayed expansion) even inside quotes, with no escape
  // (INTERFACE.md §1.1) — a --source-root under %TEMP% would reach Claude Code as a different path.
  for (const bad of ["C:\\%TEMP%\\wicked-garden", "C:\\x\\!v!\\wicked-garden"]) {
    assert.throws(
      () => prepareClaudeSpawn("claude.cmd", ["plugin", "marketplace", "add", bad], "win32"),
      /refusing to route .* through cmd\.exe/,
    );
  }
  // A native exe or a POSIX binary needs no shell, so the same argument is passed verbatim.
  assert.equal(prepareClaudeSpawn("C:\\tools\\claude.exe", ["x", "%TEMP%"], "win32").shell, false);
  assert.equal(prepareClaudeSpawn("/usr/local/bin/claude", ["x", "%TEMP%"], "linux").shell, false);
});

test("prepareClaudeSpawn: a .mjs binary runs through node, never through its shebang", () => {
  const p = prepareClaudeSpawn("/x/claude-stub.mjs", ["--version"], "linux");
  assert.equal(p.cmd, process.execPath);
  assert.deepEqual(p.argv, ["/x/claude-stub.mjs", "--version"]);
  assert.equal(p.shell, false);
});

test("resolveClaudeConfigDirs: --claude-home > CLAUDE_CONFIG_DIR (platform-split, exclusive) > ~/.claude", () => {
  const home = "/home/u";
  assert.deepEqual(
    resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: "/a:/b,/c" }, home, platform: "linux" }),
    { dirs: ["/a", "/b", "/c"], origin: "env" },
  );
  assert.deepEqual(
    resolveClaudeConfigDirs({ homeFlags: ["~/x", "/y", "/y"], env: { CLAUDE_CONFIG_DIR: "/a" }, home, platform: "linux" }),
    { dirs: [resolve("/home/u/x"), resolve("/y")], origin: "flag" },
    "flags replace the env set entirely and are de-duplicated",
  );
  assert.deepEqual(
    resolveClaudeConfigDirs({ env: {}, home, platform: "linux" }),
    { dirs: [resolve("/home/u/.claude")], origin: "default" },
  );
  assert.deepEqual(
    resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: "   " }, home, platform: "linux" }),
    { dirs: [resolve("/home/u/.claude")], origin: "default" },
    "a blank CLAUDE_CONFIG_DIR is not an override",
  );
  // Windows splits on ';' or ',' so a bare ':' never shatters a C:\ path.
  const win = resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: "C:\\cfg\\a;C:\\cfg\\b" }, home: "C:\\Users\\u", platform: "win32" });
  assert.equal(win.dirs.length, 2);
  assert.equal(win.origin, "env");
});

test("registrationVerdict: an install record alone is not a registration", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-verdict-"));
  try {
    const plugins = join(tmp, "plugins");
    const payload = join(plugins, "cache", "wicked-garden", "wicked-garden", "1.0.0");
    const record = JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: payload, version: "1.0.0" }] },
    });
    mkdirSync(plugins, { recursive: true });

    assert.equal(registrationVerdict(readRegistration(tmp, spec)).state, "absent");

    mkdirSync(join(plugins, "wicked-garden", ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugins, "wicked-garden", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.9.0" }));
    assert.equal(registrationVerdict(readRegistration(tmp, spec)).state, "copy-only");

    // A record with neither marketplace nor payload: broken, both reasons named.
    writeFileSync(join(plugins, "installed_plugins.json"), record);
    let v = registrationVerdict(readRegistration(tmp, spec));
    assert.equal(v.state, "broken");
    assert.equal(v.problems.length, 2);
    assert.match(v.problems[0], /marketplace entry missing/);
    assert.match(v.problems[1], /payload missing/);

    // Marketplace back, payload still gone: still broken.
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({
      "wicked-garden": { source: { source: "github", repo: "mikeparcewski/wicked-garden" }, installLocation: "x" },
    }));
    v = registrationVerdict(readRegistration(tmp, spec));
    assert.equal(v.state, "broken");
    assert.equal(v.problems.length, 1);
    assert.match(v.problems[0], /payload missing/);

    // Payload (its plugin manifest) on disk: registered.
    mkdirSync(join(payload, ".claude-plugin"), { recursive: true });
    writeFileSync(join(payload, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "1.0.0" }));
    v = registrationVerdict(readRegistration(tmp, spec));
    assert.equal(v.state, "registered");
    assert.deepEqual(v.problems, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("resolveMarketplaceSource: published marketplace by default; <root>/<marketplace> or <root> for a checkout; else fail", () => {
  assert.equal(resolveMarketplaceSource(spec), "mikeparcewski/wicked-garden");
  const tmp = mkdtempSync(join(tmpdir(), "wicked-src-"));
  try {
    assert.throws(() => resolveMarketplaceSource(spec, tmp), /no \.claude-plugin\/marketplace\.json under/);
    mkdirSync(join(tmp, "wicked-garden", ".claude-plugin"), { recursive: true });
    writeFileSync(join(tmp, "wicked-garden", ".claude-plugin", "marketplace.json"), "{}");
    assert.equal(resolveMarketplaceSource(spec, tmp), join(tmp, "wicked-garden"));
    assert.equal(resolveMarketplaceSource(spec, join(tmp, "wicked-garden")), join(tmp, "wicked-garden"));
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
