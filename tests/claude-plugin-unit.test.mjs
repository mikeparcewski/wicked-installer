// claude-plugin-unit.test.mjs — the pure pieces of src/claude-plugin.ts, asserted on the BUILT
// module (dist/ is what ships). Requires `npm run build` first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  claudePluginSpec,
  describeVerdict,
  planForDir,
  prepareClaudeSpawn,
  probeClaude,
  readRegistration,
  registrationVerdict,
  resolveClaudeConfigDirs,
  resolveMarketplaceSource,
  localMarketplaceUnder,
} = await import(join(root, "dist", "claude-plugin.js"));

const spec = claudePluginSpec({
  id: "wicked-garden",
  install: { marketplace: "mikeparcewski/wicked-garden", pluginId: "wicked-garden@wicked-garden" },
});
const WIN = process.platform === "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "wicked-cp-unit-"));
const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** Lay down a config dir in a given registration state. */
function configDir(base, { marketplace = false, record = false, payload = false, payloadVersion = "1.0.0", bare = false } = {}) {
  const plugins = join(base, "plugins");
  const installPath = join(plugins, "cache", "wicked-garden", "wicked-garden", "1.0.0");
  mkdirSync(plugins, { recursive: true });
  if (marketplace) {
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({
      "wicked-garden": { source: { source: "github", repo: "mikeparcewski/wicked-garden" }, installLocation: "x" },
    }));
  }
  if (record) {
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath, version: "1.0.0" }] },
    }));
  }
  if (payload) {
    mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: payloadVersion }));
  }
  if (bare) {
    mkdirSync(join(plugins, "wicked-garden", ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugins, "wicked-garden", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.9.0" }));
  }
  return { plugins, installPath };
}

test("claudePluginSpec: registry fields win; ids default to <id>@<id> / mikeparcewski/<id>", () => {
  assert.deepEqual(spec, {
    pluginId: "wicked-garden@wicked-garden",
    pluginName: "wicked-garden",
    marketplaceName: "wicked-garden",
    source: "mikeparcewski/wicked-garden",
  });
  assert.deepEqual(claudePluginSpec({ id: "acme", install: {} }), {
    pluginId: "acme@acme", pluginName: "acme", marketplaceName: "acme", source: "mikeparcewski/acme",
  });
});

test("prepareClaudeSpawn: a .cmd shim on win32 goes through cmd.exe with cmd-quoted args", () => {
  const p = prepareClaudeSpawn("C:\\tools\\claude.cmd", ["plugin", "marketplace", "add", "C:\\Users\\me\\my checkout\\wicked-garden"], "win32");
  assert.equal(p.shell, true);
  assert.deepEqual(p.argv.slice(0, 3), ["plugin", "marketplace", "add"]);
  assert.equal(p.argv[3], '"C:\\Users\\me\\my checkout\\wicked-garden"', "a path with a space is quoted for cmd.exe");
});

test("prepareClaudeSpawn: %VAR%/!VAR!-bearing args are refused for a .cmd shim rather than rewritten by cmd.exe", () => {
  for (const bad of ["C:\\%TEMP%\\wicked-garden", "C:\\x\\!v!\\wicked-garden"]) {
    assert.throws(() => prepareClaudeSpawn("claude.cmd", ["plugin", "marketplace", "add", bad], "win32"), /refusing to route .* through cmd\.exe/);
  }
  assert.equal(prepareClaudeSpawn("C:\\tools\\claude.exe", ["x", "%TEMP%"], "win32").shell, false);
  assert.equal(prepareClaudeSpawn("/usr/local/bin/claude", ["x", "%TEMP%"], "linux").shell, false);
});

test("prepareClaudeSpawn: a .mjs binary runs through node, never through its shebang", () => {
  const p = prepareClaudeSpawn("/x/claude-stub.mjs", ["--version"], "linux");
  assert.equal(p.cmd, process.execPath);
  assert.deepEqual(p.argv, ["/x/claude-stub.mjs", "--version"]);
  assert.equal(p.shell, false);
});

test("resolveClaudeConfigDirs: --claude-home > CLAUDE_CONFIG_DIR (platform-split, exclusive) > ~/.claude (only when UNSET)", () => {
  const home = "/home/u";
  assert.deepEqual(resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: "/a:/b,/c" }, home, platform: "linux" }), { dirs: ["/a", "/b", "/c"], origin: "env" });
  assert.deepEqual(
    resolveClaudeConfigDirs({ homeFlags: ["~/x", "/y", "/y"], env: { CLAUDE_CONFIG_DIR: "/a" }, home, platform: "linux" }),
    { dirs: [resolve("/home/u/x"), resolve("/y")], origin: "flag" },
    "flags replace the env set entirely and are de-duplicated",
  );
  assert.deepEqual(resolveClaudeConfigDirs({ env: {}, home, platform: "linux" }), { dirs: [resolve("/home/u/.claude")], origin: "default" });
  // Set-but-invalid is a misconfiguration, never a silent fall-through to ~/.claude.
  for (const bad of ["", "   ", ":", ",", " : , ", "\t"]) {
    assert.throws(
      () => resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: bad }, home, platform: "linux" }),
      /CLAUDE_CONFIG_DIR is set but names no directory/,
      `value ${JSON.stringify(bad)} must be rejected`,
    );
  }
  // Windows splits on ';' or ',' so a bare ':' never shatters a C:\ path.
  const win = resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: "C:\\cfg\\a;C:\\cfg\\b" }, home: "C:\\Users\\u", platform: "win32" });
  assert.equal(win.dirs.length, 2);
  assert.equal(win.origin, "env");
  assert.throws(() => resolveClaudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: ";" }, home: "C:\\Users\\u", platform: "win32" }), /names no directory/);
});

test("probeClaude: no binary → undefined; a present binary whose --version fails → an error, never 'absent'", () => {
  const calls = [];
  const spawner = (bin, args, dir, mode) => {
    calls.push({ bin, args, dir, mode });
    return bin.endsWith("broken") ? { status: 1, stdout: "", stderr: "boom" } : { status: 0, stdout: "9.9.9 (Claude Code)\n", stderr: "" };
  };
  assert.equal(probeClaude("/cfg", { env: { PATH: "/definitely/not/here" }, spawner }), undefined);
  assert.equal(calls.length, 0, "no binary ⇒ no spawn");

  const d = tmp();
  try {
    const ok = join(d, "claude-ok");
    const broken = join(d, "claude-broken");
    writeFileSync(ok, "");
    writeFileSync(broken, "");
    assert.deepEqual(probeClaude("/cfg", { env: { WICKED_CLAUDE_BIN: ok }, spawner }), { bin: ok, version: "9.9.9 (Claude Code)" });
    assert.deepEqual(calls.at(-1), { bin: ok, args: ["--version"], dir: "/cfg", mode: "capture" }, "the probe is pinned to the config dir and captured");
    assert.throws(() => probeClaude("/cfg", { env: { WICKED_CLAUDE_BIN: broken }, spawner }), /--version failed \(exit 1\): boom — Claude Code is present but not working/);
  } finally {
    rm(d);
  }
});

test("registrationVerdict: registered needs marketplace + record + matching payload; each partial state is named", () => {
  const d = tmp();
  try {
    let v = registrationVerdict(readRegistration(join(d, "absent"), spec));
    assert.equal(v.state, "absent");
    assert.equal(describeVerdict(v), "not installed");

    const bare = join(d, "bare");
    configDir(bare, { bare: true });
    v = registrationVerdict(readRegistration(bare, spec));
    assert.equal(v.state, "copy-only");
    assert.equal(describeVerdict(v), "copy only (unregistered)");

    const recordOnly = join(d, "record-only");
    configDir(recordOnly, { record: true });
    v = registrationVerdict(readRegistration(recordOnly, spec));
    assert.equal(v.state, "partial");
    assert.equal(v.problems.length, 2);
    assert.match(v.problems[0], /marketplace entry missing/);
    assert.match(v.problems[1], /payload dir missing/);
    assert.match(describeVerdict(v), /^partially registered \(marketplace entry missing.*; payload dir missing/);

    const noPayload = join(d, "no-payload");
    configDir(noPayload, { marketplace: true, record: true });
    v = registrationVerdict(readRegistration(noPayload, spec));
    assert.equal(v.state, "partial");
    assert.deepEqual(v.problems.map((p) => p.split(":")[0]), ["payload dir missing"]);

    const noMarketplace = join(d, "no-marketplace");
    configDir(noMarketplace, { record: true, payload: true });
    v = registrationVerdict(readRegistration(noMarketplace, spec));
    assert.equal(v.state, "partial");
    assert.match(v.problems.join(" "), /marketplace entry missing/);
    assert.doesNotMatch(v.problems.join(" "), /payload/);

    const mismatch = join(d, "mismatch");
    configDir(mismatch, { marketplace: true, record: true, payload: true, payloadVersion: "1.0.1" });
    v = registrationVerdict(readRegistration(mismatch, spec));
    assert.equal(v.state, "partial");
    assert.match(v.problems[0], /payload plugin\.json version 1\.0\.1 does not match the install record \(1\.0\.0\)/);

    // A record whose installPath is a valid-looking plugin ANYWHERE ELSE — even inside the config
    // dir — is not a registration: Claude Code and crew read plugins/cache/<mkt>/<plugin>/<version>.
    const elsewhere = join(d, "elsewhere");
    const { plugins } = configDir(elsewhere, { marketplace: true });
    const stray = join(plugins, "cache", "wicked-garden", "wicked-garden", "somewhere-else");
    mkdirSync(join(stray, ".claude-plugin"), { recursive: true });
    writeFileSync(join(stray, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "1.0.0" }));
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: stray, version: "1.0.0" }] },
    }));
    v = registrationVerdict(readRegistration(elsewhere, spec));
    assert.equal(v.state, "partial");
    assert.match(v.problems[0], /is not the expected cache path .*[\\/]cache[\\/]wicked-garden[\\/]wicked-garden[\\/]1\.0\.0$/);

    const good = join(d, "good");
    configDir(good, { marketplace: true, record: true, payload: true });
    v = registrationVerdict(readRegistration(good, spec));
    assert.equal(v.state, "registered");
    assert.deepEqual(v.problems, []);
    assert.equal(describeVerdict(v), "registered");
  } finally {
    rm(d);
  }
});

test("readRegistration: symlinked registration files and escapes are refused and reported as errors (unreadable), not as 'not installed'", { skip: WIN && "symlink creation needs privileges on Windows" }, () => {
  const d = tmp();
  try {
    // A symlinked installed_plugins.json — even one pointing at a valid file inside the dir.
    const linked = join(d, "linked");
    const { plugins } = configDir(linked, { marketplace: true, payload: true });
    writeFileSync(join(plugins, "real-installed.json"), JSON.stringify({ version: 2, plugins: {} }));
    symlinkSync(join(plugins, "real-installed.json"), join(plugins, "installed_plugins.json"));
    let reg = readRegistration(linked, spec);
    assert.equal(reg.errors.length, 1);
    assert.match(reg.errors[0], /installed_plugins\.json: is a symlink — refusing to follow it/);
    let v = registrationVerdict(reg);
    assert.equal(v.state, "unreadable");
    assert.match(describeVerdict(v), /^unreadable \(/);

    // A cache dir that is a symlink out of the config dir.
    const escaped = join(d, "escaped");
    const outside = join(d, "outside-cache");
    mkdirSync(join(outside, "1.0.0"), { recursive: true });
    configDir(escaped, { marketplace: true });
    mkdirSync(join(escaped, "plugins", "cache", "wicked-garden"), { recursive: true });
    symlinkSync(outside, join(escaped, "plugins", "cache", "wicked-garden", "wicked-garden"));
    reg = readRegistration(escaped, spec);
    assert.ok(reg.errors.some((e) => /is a symlink — refusing to follow it/.test(e)), JSON.stringify(reg.errors));
    assert.equal(registrationVerdict(reg).state, "unreadable");

    // A record whose installPath is a symlink is a payload problem, not a registration.
    const linkedPayload = join(d, "linked-payload");
    const cfg = configDir(linkedPayload, { marketplace: true, record: true });
    mkdirSync(join(outside, "payload", ".claude-plugin"), { recursive: true });
    writeFileSync(join(outside, "payload", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
    mkdirSync(dirname(cfg.installPath), { recursive: true });
    symlinkSync(join(outside, "payload"), cfg.installPath);
    reg = readRegistration(linkedPayload, spec);
    v = registrationVerdict(reg);
    assert.equal(v.state, "partial", JSON.stringify(reg));
    assert.match(v.problems[0], /is a symlink — refusing to follow it/);
  } finally {
    rm(d);
  }
});

test("planForDir: commands follow the on-disk state exactly (add only when absent; update when healthy; install when partial)", () => {
  const d = tmp();
  try {
    const fresh = join(d, "fresh");
    let plan = planForDir(fresh, spec, "mikeparcewski/wicked-garden");
    assert.deepEqual(plan.commands.map((c) => c.args), [
      ["plugin", "marketplace", "add", "mikeparcewski/wicked-garden"],
      ["plugin", "install", "wicked-garden@wicked-garden"],
    ]);
    assert.match(plan.probes[0], /known_marketplaces\.json → marketplace wicked-garden: not registered$/);
    assert.match(plan.probes[1], /installed_plugins\.json → wicked-garden@wicked-garden: not installed$/);
    assert.equal(plan.commands[0].render, `CLAUDE_CONFIG_DIR=${fresh} claude plugin marketplace add mikeparcewski/wicked-garden`);

    const healthy = join(d, "healthy");
    configDir(healthy, { marketplace: true, record: true, payload: true });
    plan = planForDir(healthy, spec, "mikeparcewski/wicked-garden");
    assert.deepEqual(plan.commands.map((c) => c.args), [["plugin", "update", "wicked-garden@wicked-garden"]]);
    assert.match(plan.probes[0], /registered \(github:mikeparcewski\/wicked-garden\)$/);
    assert.match(plan.commands[0].because, /installed 1\.0\.0/);

    const partial = join(d, "partial");
    configDir(partial, { marketplace: true, record: true });
    plan = planForDir(partial, spec, "mikeparcewski/wicked-garden");
    assert.deepEqual(plan.commands.map((c) => c.args), [["plugin", "install", "wicked-garden@wicked-garden"]]);
    assert.match(plan.commands[0].because, /install record present but payload dir missing/);

    // A marketplace registered from ANOTHER source (a local checkout) is kept, not re-added.
    const local = join(d, "local");
    configDir(local, { record: true, payload: true });
    writeFileSync(join(local, "plugins", "known_marketplaces.json"), JSON.stringify({
      "wicked-garden": { source: { source: "directory", path: "/somewhere/wicked-garden" }, installLocation: "/somewhere/wicked-garden" },
    }));
    plan = planForDir(local, spec, "mikeparcewski/wicked-garden");
    assert.deepEqual(plan.commands.map((c) => c.args[1]), ["update"]);
    assert.match(plan.probes[0], /registered \(directory:\/somewhere\/wicked-garden\)$/);
  } finally {
    rm(d);
  }
});

test("resolveMarketplaceSource / localMarketplaceUnder: explicit roots must hold a manifest; implicit ones may not", () => {
  assert.equal(resolveMarketplaceSource(spec), "mikeparcewski/wicked-garden");
  const d = tmp();
  try {
    assert.throws(() => resolveMarketplaceSource(spec, d), /no \.claude-plugin\/marketplace\.json under/);
    assert.equal(localMarketplaceUnder(spec, d), undefined, "an implicit root without a manifest is simply not local");
    mkdirSync(join(d, "wicked-garden", ".claude-plugin"), { recursive: true });
    writeFileSync(join(d, "wicked-garden", ".claude-plugin", "marketplace.json"), "{}");
    assert.equal(resolveMarketplaceSource(spec, d), join(d, "wicked-garden"));
    assert.equal(resolveMarketplaceSource(spec, join(d, "wicked-garden")), join(d, "wicked-garden"));
    assert.equal(localMarketplaceUnder(spec, d), join(d, "wicked-garden"));
  } finally {
    rm(d);
  }
});
