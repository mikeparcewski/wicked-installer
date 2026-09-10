// claude-plugin-unit.test.mjs — the pure pieces of src/claude-plugin.ts, asserted on the BUILT
// module (dist/ is what ships). Requires `npm run build` first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  claudePluginSpec,
  describeVerdict,
  detectLegacyCopies,
  planClaudePlugin,
  planForDir,
  prepareClaudeSpawn,
  probeClaude,
  readRegistration,
  registrationVerdict,
  renderClaudeCommand,
  resolveClaudeConfigDirs,
  resolveMarketplaceSource,
  localMarketplaceUnder,
  expandHome,
  shellQuote,
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
    assert.match(v.problems[0], /is not the expected cache path .*[\\/]cache[\\/]wicked-garden[\\/]wicked-garden[\\/]1\.0\.0 \(user scope\)$/);

    // A record without a version is never completed with a placeholder: it is partial, named as such.
    const noVersion = join(d, "no-version");
    const nv = configDir(noVersion, { marketplace: true, payload: true });
    writeFileSync(join(nv.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: nv.installPath }] },
    }));
    const noVersionReg = readRegistration(noVersion, spec);
    assert.equal(noVersionReg.installed[0].version, "", "no synthesized version");
    // The raw string is kept: a padded version is not silently normalised into a valid one.
    writeFileSync(join(nv.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: nv.installPath, version: " 1.0.0 " }] },
    }));
    const padded = readRegistration(noVersion, spec);
    assert.equal(padded.installed[0].version, " 1.0.0 ");
    assert.equal(registrationVerdict(padded).state, "partial");
    assert.match(registrationVerdict(padded).problems[0], /record version " 1\.0\.0 " is not a path segment/);
    // DEL and C1 controls are control characters too — not just C0.
    for (const bad of ["1.0.0\u007f", "1.0\u0085.0", "1.0.0\u009f"]) {
      writeFileSync(join(nv.plugins, "installed_plugins.json"), JSON.stringify({
        version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: nv.installPath, version: bad }] },
      }));
      const ctl = registrationVerdict(readRegistration(noVersion, spec));
      assert.equal(ctl.state, "partial", JSON.stringify(bad));
      assert.match(ctl.problems[0], /is not a path segment/, JSON.stringify(bad));
    }
    // A selected key whose value is malformed is an unhealthy record, never "not installed".
    for (const raw of [[null], "1.0.0", 42, [{ scope: "user", installPath: nv.installPath, version: "1.0.0" }, null]]) {
      writeFileSync(join(nv.plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "wicked-garden@wicked-garden": raw } }));
      const mal = registrationVerdict(readRegistration(noVersion, spec));
      assert.equal(mal.state, "partial", JSON.stringify(raw));
      assert.ok(mal.problems.includes("install record is malformed (not an object) (unknown scope)"), JSON.stringify(mal));
    }
    v = registrationVerdict(noVersionReg);
    assert.equal(v.state, "partial");
    assert.deepEqual(v.problems, ["install record has no version (user scope)"]);

    // Two scopes: a healthy user-scope record does not excuse a project-scope record without a
    // version — the dir is partial regardless of the other entries.
    const twoScopes = join(d, "two-scopes");
    const ts = configDir(twoScopes, { marketplace: true, payload: true });
    writeFileSync(join(ts.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [
        { scope: "user", installPath: ts.installPath, version: "1.0.0" },
        { scope: "project", projectPath: "/some/project", installPath: ts.installPath },
      ] },
    }));
    v = registrationVerdict(readRegistration(twoScopes, spec));
    assert.equal(v.state, "partial");
    assert.deepEqual(v.problems, ["install record has no version (project scope)"]);

    // Likewise a healthy user-scope record does not excuse a project-scope record whose payload
    // is missing (a version that has no cache dir) or mismatched — every selected record verifies.
    writeFileSync(join(ts.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [
        { scope: "user", installPath: ts.installPath, version: "1.0.0" },
        { scope: "project", projectPath: "/some/project", installPath: join(ts.plugins, "cache", "wicked-garden", "wicked-garden", "2.0.0"), version: "2.0.0" },
      ] },
    }));
    v = registrationVerdict(readRegistration(twoScopes, spec));
    assert.equal(v.state, "partial", JSON.stringify(v));
    assert.equal(v.problems.length, 1);
    assert.match(v.problems[0], /^payload dir missing: .*2\.0\.0 \(project scope\)$/);
    writeFileSync(join(ts.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [
        { scope: "user", installPath: ts.installPath, version: "1.0.0" },
        { scope: "managed", installPath: ts.installPath, version: "1.0.1" }, // record says 1.0.1, payload is 1.0.0
      ] },
    }));
    v = registrationVerdict(readRegistration(twoScopes, spec));
    assert.equal(v.state, "partial", JSON.stringify(v));
    assert.match(v.problems[0], /is not the expected cache path .*\(managed scope\)$/);

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

test("shellQuote / renderClaudeCommand: printed commands are quoted for the platform's shell", () => {
  assert.equal(shellQuote("/plain/path-1.2", "linux"), "/plain/path-1.2");
  assert.equal(shellQuote("/cfg with space", "linux"), "'/cfg with space'");
  assert.equal(shellQuote("a$b&c", "linux"), "'a$b&c'");
  assert.equal(shellQuote("it's", "linux"), "'it'\\''s'");
  assert.equal(shellQuote("", "linux"), "''");
  assert.equal(shellQuote("C:\\cfg with space", "win32"), '"C:\\cfg with space"');
  assert.equal(
    renderClaudeCommand("/home/u/cfg with space$and&amp", ["plugin", "install", "wicked-garden@wicked-garden"], "linux"),
    "CLAUDE_CONFIG_DIR='/home/u/cfg with space$and&amp' claude plugin install wicked-garden@wicked-garden",
  );
  assert.equal(
    renderClaudeCommand("/home/u/.claude", ["plugin", "marketplace", "add", "/src/my checkout/wicked-garden"], "linux"),
    "CLAUDE_CONFIG_DIR=/home/u/.claude claude plugin marketplace add '/src/my checkout/wicked-garden'",
  );
  // cmd.exe has no `VAR=value cmd` form: `set "VAR=value" && …`, args quoted per the .cmd rules.
  assert.equal(
    renderClaudeCommand("C:\\Users\\me\\cfg with space", ["plugin", "marketplace", "add", "C:\\src\\my checkout\\wicked-garden"], "win32"),
    'set "CLAUDE_CONFIG_DIR=C:\\Users\\me\\cfg with space" && claude plugin marketplace add "C:\\src\\my checkout\\wicked-garden"',
  );
  assert.equal(
    renderClaudeCommand("C:\\cfg", ["plugin", "install", "wicked-garden@wicked-garden"], "win32"),
    'set "CLAUDE_CONFIG_DIR=C:\\cfg" && claude plugin install wicked-garden@wicked-garden',
  );
  // cmd.exe expands %VAR% / !VAR! even inside quotes: such a dir or argument is never shown as a
  // pasteable cmd.exe line that would point somewhere else — it is rendered structurally.
  for (const [dir, args] of [
    ["C:\\work\\%TEMP%\\cfg", ["plugin", "install", "wicked-garden@wicked-garden"]],
    ["C:\\cfg", ["plugin", "marketplace", "add", "C:\\src\\!v!\\wicked-garden"]],
  ]) {
    const rendered = renderClaudeCommand(dir, args, "win32");
    assert.doesNotMatch(rendered, /^set "CLAUDE_CONFIG_DIR=/, rendered);
    assert.ok(rendered.startsWith(`claude ${JSON.stringify(args)} with env CLAUDE_CONFIG_DIR=${JSON.stringify(dir)}`), rendered);
    assert.match(rendered, /% or ! would be expanded by the shell/);
  }
});

test("readRegistration: symlinked registration files and escapes are refused and reported as errors (unreadable), not as 'not installed'", { skip: WIN && "symlink creation needs privileges on Windows" }, async () => {
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

    // A record whose installPath is a symlink is an I/O-class failure: UNREADABLE (an error), not
    // merely partial — the state cannot be trusted, and status must exit non-zero.
    const linkedPayload = join(d, "linked-payload");
    const cfg = configDir(linkedPayload, { marketplace: true, record: true });
    mkdirSync(join(outside, "payload", ".claude-plugin"), { recursive: true });
    writeFileSync(join(outside, "payload", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
    mkdirSync(dirname(cfg.installPath), { recursive: true });
    symlinkSync(join(outside, "payload"), cfg.installPath);
    reg = readRegistration(linkedPayload, spec);
    v = registrationVerdict(reg);
    assert.equal(v.state, "unreadable", JSON.stringify(reg));
    assert.match(v.problems[0], /is a symlink — refusing to follow it/);
    assert.equal(reg.installed[0].payload.ok, false);

    // The EXPECTED cache path itself may not be a link either: a record pointing at the real
    // directory while plugins/cache/…/<version> is a symlink to it would make the realpath
    // comparison pass — the component-wise lstat of the expected chain catches it.
    const linkedExpected = join(d, "linked-expected");
    const le = configDir(linkedExpected, { marketplace: true });
    const realDir = join(le.plugins, "cache", "wicked-garden", "wicked-garden", "real-1.0.0");
    mkdirSync(join(realDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(realDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "1.0.0" }));
    symlinkSync(realDir, le.installPath); // plugins/cache/wicked-garden/wicked-garden/1.0.0 -> real-1.0.0
    writeFileSync(join(le.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: realDir, version: "1.0.0" }] },
    }));
    reg = readRegistration(linkedExpected, spec);
    v = registrationVerdict(reg);
    assert.equal(v.state, "unreadable", JSON.stringify(reg));
    assert.ok(reg.errors.some((e) => /wicked-garden[\\/]1\.0\.0: is a symlink — refusing to follow it/.test(e)), JSON.stringify(reg.errors));

    // The recorded version is ONE path component: `alias/1.0.0` (with `alias` an in-config symlink
    // to a real version dir) must not smuggle an intermediate component past the chain check.
    const smuggled = join(d, "smuggled");
    const sm = configDir(smuggled, { marketplace: true, payload: true });
    symlinkSync(join(sm.plugins, "cache", "wicked-garden", "wicked-garden"), join(sm.plugins, "cache", "wicked-garden", "wicked-garden", "alias"));
    writeFileSync(join(sm.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: join(sm.plugins, "cache", "wicked-garden", "wicked-garden", "alias", "1.0.0"), version: "alias/1.0.0" }] },
    }));
    reg = readRegistration(smuggled, spec);
    v = registrationVerdict(reg);
    assert.notEqual(v.state, "registered", JSON.stringify(reg));
    // The symlink inside the cache dir is itself refused by the listing → unreadable (stricter still).
    assert.equal(v.state, "unreadable");
    assert.ok(reg.errors.some((e) => /[\\/]alias: is a symlink — refusing to follow it/.test(e)), JSON.stringify(reg.errors));
    assert.match(reg.installed[0].payload.problem, /record version "alias\/1\.0\.0" is not a path segment/, "and the version was refused as a path segment regardless");

    // The segment rule on its own (no symlink anywhere): a REAL nested directory named by a
    // multi-component version must still not register — the version is not a path.
    const nested = join(d, "nested-version");
    const nv = configDir(nested, { marketplace: true });
    const nestedPayload = join(nv.plugins, "cache", "wicked-garden", "wicked-garden", "alias", "1.0.0");
    mkdirSync(join(nestedPayload, ".claude-plugin"), { recursive: true });
    writeFileSync(join(nestedPayload, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "alias/1.0.0" }));
    writeFileSync(join(nv.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: nestedPayload, version: "alias/1.0.0" }] },
    }));
    v = registrationVerdict(readRegistration(nested, spec));
    assert.equal(v.state, "partial", JSON.stringify(v));
    assert.match(v.problems[0], /record version "alias\/1\.0\.0" is not a path segment/);
    for (const bad of ["..", ".", ".hidden", "a\\b", "1.0.0/", "a b", " 1.0.0 ", "1.0.0\t", "\n1.0.0"]) {
      writeFileSync(join(nv.plugins, "installed_plugins.json"), JSON.stringify({
        version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: nv.installPath, version: bad }] },
      }));
      const verdict = registrationVerdict(readRegistration(nested, spec));
      assert.equal(verdict.state, "partial", `version ${JSON.stringify(bad)} must never register`);
      assert.match(verdict.problems[0], /is not a path segment/, JSON.stringify(verdict));
    }

    // A record reaching the real payload through a symlinked ALIAS of the marketplace dir is not
    // the expected path: realpath-equivalence is not enough — the recorded path must be exact.
    const aliased = join(d, "aliased");
    const al = configDir(aliased, { marketplace: true, payload: true });
    const aliasDir = join(al.plugins, "cache", "wicked-garden-alias");
    symlinkSync(join(al.plugins, "cache", "wicked-garden"), aliasDir);
    writeFileSync(join(al.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath: join(aliasDir, "wicked-garden", "1.0.0"), version: "1.0.0" }] },
    }));
    reg = readRegistration(aliased, spec);
    v = registrationVerdict(reg);
    assert.equal(v.state, "partial", JSON.stringify(reg));
    assert.match(v.problems[0], /record path .*wicked-garden-alias.* is not the expected cache path/);

    // No normalisation before the comparison: `<expected>/alias/..` — with `alias` a symlink to a
    // child dir — resolves to the expected path but is NOT it; neither is `<expected>/./`. Only
    // trailing separators are forgiven.
    const dotted = join(d, "dotted");
    const dt = configDir(dotted, { marketplace: true, payload: true });
    symlinkSync(join(dt.installPath, ".claude-plugin"), join(dt.installPath, "alias"));
    const record = (installPath) => writeFileSync(join(dt.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath, version: "1.0.0" }] },
    }));
    record(`${dt.installPath}${sep}alias${sep}..`); // built by concatenation: path.join would normalise the `..` away
    v = registrationVerdict(readRegistration(dotted, spec));
    assert.notEqual(v.state, "registered", JSON.stringify(v));
    assert.equal(v.state, "partial");
    assert.match(v.problems[0], /record path .*[\\/]alias[\\/]\.\. is not the expected cache path/);
    record(dt.installPath + "/./");
    v = registrationVerdict(readRegistration(dotted, spec));
    assert.equal(v.state, "partial", JSON.stringify(v));
    assert.match(v.problems[0], /record path .* is not the expected cache path/);
    record(dt.installPath + "/");
    v = registrationVerdict(readRegistration(dotted, spec));
    assert.equal(v.state, "registered", "a trailing separator is the only forgiven difference: " + JSON.stringify(v));

    // Ancestors too: a symlinked `plugins/` or `<marketplace>/` component — even one resolving
    // elsewhere INSIDE the config dir — makes the state unreadable.
    const linkedPlugins = join(d, "linked-plugins");
    mkdirSync(join(linkedPlugins, "real-plugins"), { recursive: true });
    configDir(join(linkedPlugins, "staging"), { marketplace: true, record: true, payload: true }); // a fully valid tree …
    symlinkSync(join(linkedPlugins, "staging", "plugins"), join(linkedPlugins, "plugins"));       // … reached through a link
    reg = readRegistration(linkedPlugins, spec);
    assert.equal(registrationVerdict(reg).state, "unreadable", JSON.stringify(reg));
    assert.match(reg.errors[0], /[\\/]plugins: is a symlink — refusing to follow it/);

    const linkedMarketplace = join(d, "linked-marketplace");
    configDir(linkedMarketplace, { marketplace: true, record: true, payload: true });
    const mktDir = join(linkedMarketplace, "plugins", "cache", "wicked-garden");
    const moved = join(linkedMarketplace, "plugins", "cache", "elsewhere-inside-root");
    // move the real marketplace dir aside and link its old name to it
    const { renameSync } = await import("node:fs");
    renameSync(mktDir, moved);
    symlinkSync(moved, mktDir);
    reg = readRegistration(linkedMarketplace, spec);
    assert.equal(registrationVerdict(reg).state, "unreadable", JSON.stringify(reg));
    assert.ok(reg.errors.some((e) => /cache[\\/]wicked-garden: is a symlink — refusing to follow it/.test(e)), JSON.stringify(reg.errors));
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
    assert.match(plan.commands[0].because, /install record present but user scope: payload dir missing/);

    // A healthy user-scope record plus a broken project-scope record: `update` cannot repair the
    // project record, so the plan is `install`, naming the record that is wrong.
    const mixed = join(d, "mixed");
    const mx = configDir(mixed, { marketplace: true, payload: true });
    writeFileSync(join(mx.plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wicked-garden@wicked-garden": [
        { scope: "user", installPath: mx.installPath, version: "1.0.0" },
        { scope: "project", projectPath: "/p", installPath: join(mx.plugins, "cache", "wicked-garden", "wicked-garden", "2.0.0"), version: "2.0.0" },
        { scope: "managed", installPath: mx.installPath },
      ] },
    }));
    plan = planForDir(mixed, spec, "mikeparcewski/wicked-garden");
    assert.deepEqual(plan.commands.map((c) => c.args), [["plugin", "install", "wicked-garden@wicked-garden"]]);
    assert.match(plan.commands[0].because, /project scope: payload dir missing/);
    assert.match(plan.commands[0].because, /managed scope: no version/);
    assert.match(plan.probes[1], /1\.0\.0 \(user\), 2\.0\.0 \(project\); payload dir missing.*\(no version\) \(managed\)/, "the probe lists every record");

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

test("planClaudePlugin: the dry-run plan refuses what the live spawn would refuse (a .cmd-shim claude with %/! in an argument)", () => {
  const d = tmp();
  try {
    const cmdShim = join(d, "claude.cmd");
    writeFileSync(cmdShim, "");
    const cfg = join(d, "cfg");
    mkdirSync(cfg);
    const spawner = () => ({ status: 0, stdout: "9.9.9 (Claude Code)\n", stderr: "" });
    const env = { WICKED_CLAUDE_BIN: cmdShim };
    const configDirs = { dirs: [cfg], origin: "env" };
    // A checkout under %TEMP% cannot be passed through cmd.exe unchanged: the plan fails as the live run would.
    assert.throws(
      () => planClaudePlugin(spec, { configDirs, source: "C:\\%TEMP%\\wicked-garden", env, spawner, platform: "win32" }),
      /refusing to route .* through cmd\.exe/,
    );
    // The same source is fine when the binary is a native exe (no shell involved).
    const exe = join(d, "claude.exe");
    writeFileSync(exe, "");
    const plan = planClaudePlugin(spec, { configDirs, source: "C:\\%TEMP%\\wicked-garden", env: { WICKED_CLAUDE_BIN: exe }, spawner, platform: "win32" });
    assert.equal(plan.claudeDetected, true);
    assert.ok(plan.plans[0].commands.some((c) => c.args[2] === "add"));
  } finally {
    rm(d);
  }
});

test("detectLegacyCopies: reports a bare copy, a v2 marker entry with files, a carried-forward entry, and a v1 (array) marker entry", () => {
  const d = tmp();
  try {
    const cfg = join(d, "cfg");
    configDir(cfg, { bare: true });
    let found = detectLegacyCopies(cfg, spec);
    assert.deepEqual(found, [join(cfg, "plugins", "wicked-garden")]);

    const markerDir = join(cfg, "wicked-installer");
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, "claude-install.json");
    writeFileSync(markerPath, JSON.stringify({ installedAt: "2025-12-01T00:00:00.000Z", claudeHome: cfg, products: [{ id: "wicked-garden", success: true }] }));
    found = detectLegacyCopies(cfg, spec);
    assert.equal(found.length, 2);
    assert.equal(found[1], `${markerPath} (install-claude.js v1 marker entry)`);

    writeFileSync(markerPath, JSON.stringify({ markerVersion: 2, cli: "claude", configDir: cfg, updatedAt: "x", products: { "wicked-garden": { installedAt: "x", lastResult: "installed", files: [{ kind: "dir", path: "skills/wicked-garden-core" }], notes: [] } } }));
    assert.equal(detectLegacyCopies(cfg, spec)[1], `${markerPath} (install-claude.js marker: 1 recorded path(s))`);

    writeFileSync(markerPath, JSON.stringify({ markerVersion: 2, cli: "claude", configDir: cfg, updatedAt: "x", products: { "wicked-garden": { installedAt: "x", lastResult: "installed", files: [], notes: ["carried forward from a v1 marker: no file manifest"] } } }));
    assert.equal(detectLegacyCopies(cfg, spec)[1], `${markerPath} (install-claude.js marker: entry carried forward from a v1 marker, no file manifest)`);

    // A marker naming only other products is not a garden legacy copy.
    writeFileSync(markerPath, JSON.stringify({ installedAt: "x", products: [{ id: "wicked-vault", success: true }] }));
    assert.equal(detectLegacyCopies(cfg, spec).length, 1);
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
    writeFileSync(join(d, "wicked-garden", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "wicked-garden" }));
    assert.equal(resolveMarketplaceSource(spec, d), join(d, "wicked-garden"));
    assert.equal(resolveMarketplaceSource(spec, join(d, "wicked-garden")), join(d, "wicked-garden"));
    assert.equal(localMarketplaceUnder(spec, d), join(d, "wicked-garden"));
    // A manifest naming another marketplace (or none, or unparseable) is an error — the install and
    // rollback commands are addressed to spec.marketplaceName, so it must never be registered.
    const manifest = join(d, "wicked-garden", ".claude-plugin", "marketplace.json");
    writeFileSync(manifest, JSON.stringify({ name: "other-market" }));
    assert.throws(() => resolveMarketplaceSource(spec, d), /declares marketplace "other-market", expected "wicked-garden"/);
    assert.throws(() => localMarketplaceUnder(spec, d), /declares marketplace "other-market"/);
    writeFileSync(manifest, "{}");
    assert.throws(() => resolveMarketplaceSource(spec, d), /declares marketplace \(no name\), expected "wicked-garden"/);
    writeFileSync(manifest, "{ not json");
    assert.throws(() => resolveMarketplaceSource(spec, d), /marketplace\.json: not valid JSON/);
  } finally {
    rm(d);
  }
});

test("expandHome: a leading ~ (alone or before a separator) becomes the home dir; nothing else changes", () => {
  assert.equal(expandHome("~/checkouts", "/h"), "/h/checkouts");
  assert.equal(expandHome("~\\checkouts", "/h"), "/h\\checkouts");
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~user/x", "/h"), "~user/x");
  assert.equal(expandHome("/abs/~/x", "/h"), "/abs/~/x");
  assert.equal(expandHome("~/x", "/h$1"), "/h$1/x", "a $ in the home path is not a replacement token");
});
