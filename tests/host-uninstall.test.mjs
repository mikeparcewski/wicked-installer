import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hosts = { codex: ".codex", opencode: ".config/opencode", pi: ".pi/agent", antigravity: ".gemini" };
const cleanKeys = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_HOME", "PI_CODING_AGENT_DIR", "OPENCODE_CONFIG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "WICKED_CLAUDE_BIN"];
function world() {
  const home = mkdtempSync(join(tmpdir(), "wicked-uninstall-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const w = { home, bin };
  stub(w, "codex", `'${join(ROOT, "tests/codex-stub.mjs")}' "$@"`);
  return w;
}
function run(w, cli, args, extra = {}) {
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home, PATH: `${w.bin}:/usr/bin:/bin`, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of cleanKeys) delete env[key];
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [join(ROOT, "dist", cli === "central" ? "index.js" : `install-${cli}.js`), ...args], { env, cwd: w.home, encoding: "utf8", timeout: 60000 });
  r.out = `${r.stdout}${r.stderr}`;
  return r;
}
function json(r) { assert.ok(r.stdout.trim(), r.out); return JSON.parse(r.stdout); }
function marker(w, cli, products) {
  const home = join(w.home, hosts[cli]);
  const file = join(home, "wicked-installer", `${cli}-install.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ products }));
  return { home, file, skills: join(home, ...(cli === "antigravity" ? ["config", "skills"] : ["skills"])) };
}
function skill(base, name, frontmatter = name) {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, "SKILL.md"), `---\nname: ${frontmatter}\n---\n`);
}
function stub(w, name, body) {
  const p = join(w.bin, name);
  writeFileSync(p, `#!/bin/sh\nexec '${process.execPath}' ${body}\n`); chmodSync(p, 0o755);
}
const entry = (id, skills = []) => ({ id, skills, assets: { skills: skills.length, hooks: 1 } });
for (const cli of Object.keys(hosts)) {
  test(`uninstall ${cli}: recorded assets only, dry run, named selection, and absent marker`, () => {
    const w = world();
    try {
      const m = marker(w, cli, [entry("wicked-garden", ["wicked-garden-one", "linked", "changed", "file", "../escape", ".hidden", "linked-header", "directory-header", "missing-header"]), entry("wicked-estate", ["wicked-estate-two"])]);
      skill(m.skills, "wicked-garden-one"); skill(m.skills, "wicked-estate-two"); skill(m.skills, "foreign"); skill(m.skills, "changed", "different");
      writeFileSync(join(m.skills, "file"), "keep");
      const outside = join(w.home, "outside"); skill(outside, "linked"); symlinkSync(join(outside, "linked"), join(m.skills, "linked"));
      skill(outside, "linked-header");
      mkdirSync(join(m.skills, "linked-header"));
      symlinkSync(join(outside, "linked-header", "SKILL.md"), join(m.skills, "linked-header", "SKILL.md"));
      mkdirSync(join(m.skills, "directory-header", "SKILL.md"), { recursive: true });
      mkdirSync(join(m.skills, "missing-header"));
      const adapter = cli === "opencode" ? "plugins" : cli === "pi" ? "extensions" : undefined;
      if (adapter) {
        mkdirSync(join(m.home, adapter, "wicked-garden-hooks"), { recursive: true });
        writeFileSync(join(m.home, adapter, "wicked-garden.ts"), "adapter");
      }
      const before = readFileSync(m.file, "utf8");
      let r = run(w, cli, ["--json", "--dry-run", "uninstall", "--all"]);
      assert.equal(r.status, 0, r.out); assert.equal(readFileSync(m.file, "utf8"), before); assert.ok(existsSync(join(m.skills, "wicked-garden-one")));
      assert.match(JSON.stringify(json(r)), /would remove/);
      r = run(w, cli, ["--json", "uninstall", "wicked-garden"]);
      assert.equal(r.status, 0, r.out); assert.ok(!existsSync(join(m.skills, "wicked-garden-one"))); assert.ok(existsSync(join(m.skills, "wicked-estate-two")));
      assert.deepEqual(JSON.parse(readFileSync(m.file, "utf8")).products.map(p => p.id), ["wicked-estate"]);
      assert.ok(lstatSync(join(m.skills, "linked")).isSymbolicLink()); assert.ok(existsSync(join(m.skills, "foreign"))); assert.ok(existsSync(join(m.skills, "changed"))); assert.ok(existsSync(join(m.skills, "file")));
      assert.match(JSON.stringify(json(r)), /changed by hand; left in place/);
      assert.ok(json(r).reports[0].removed.includes(join(m.skills, "wicked-garden-one")), "JSON retains full removed paths");
      assert.ok(lstatSync(join(m.skills, "linked-header", "SKILL.md")).isSymbolicLink());
      assert.ok(lstatSync(join(m.skills, "directory-header", "SKILL.md")).isDirectory());
      assert.ok(existsSync(join(m.skills, "missing-header")));
      if (adapter) { assert.ok(!existsSync(join(m.home, adapter, "wicked-garden.ts"))); assert.ok(!existsSync(join(m.home, adapter, "wicked-garden-hooks"))); }
      r = run(w, cli, ["uninstall", "--all", "--json"]); assert.equal(r.status, 0, r.out); assert.ok(!existsSync(m.file)); assert.ok(!existsSync(dirname(m.file)));
      r = run(w, cli, ["uninstall", "--all", "--json"]); assert.equal(r.status, 2, r.out); assert.deepEqual(json(r).reports, []);
    } finally { rmSync(w.home, { recursive: true, force: true }); }
  });
  test(`uninstall ${cli}: legacy heuristic and malformed marker fail closed`, () => {
    const w = world();
    try {
      const m = marker(w, cli, [{ id: "wicked-garden", assets: { skills: 1 } }]);
      skill(m.skills, "wicked-garden-old"); skill(m.skills, "wicked-garden-changed", "foreign"); skill(m.skills, "foreign");
      let r = run(w, cli, ["uninstall", "--all", "--json"]); assert.equal(r.status, 0, r.out); assert.equal(json(r).reports[0].heuristic, true); assert.ok(!existsSync(join(m.skills, "wicked-garden-old"))); assert.ok(existsSync(join(m.skills, "wicked-garden-changed")));
      for (const body of ['{bad', '{"products":{}}']) {
        mkdirSync(dirname(m.file), { recursive: true }); writeFileSync(m.file, body);
        r = run(w, cli, ["uninstall", "--all", "--json"]); assert.equal(r.status, 1, r.out); assert.ok(r.out.includes(m.file), r.out); assert.equal(readFileSync(m.file, "utf8"), body);
      }
      marker(w, cli, [entry("wicked-garden")]);
      r = run(w, cli, ["uninstall", "unknown", "--json"]); assert.equal(r.status, 1, r.out); assert.ok(existsSync(m.file));
      r = run(w, cli, ["uninstall", "wicked-bus", "--json"]); assert.equal(r.status, 0, r.out); assert.equal(json(r).reports[0].skipped, true);
    } finally { rmSync(w.home, { recursive: true, force: true }); }
  });
}

test("uninstall codex: plugin removal respects marketplace ownership and remaining users", () => {
  for (const [owned, shared] of [[true, false], [false, false], [true, true]]) {
    const w = world();
    try {
      const m = marker(w, "codex", [{ ...entry("wicked-garden"), codexPlugin: { pluginId: "wicked-garden@wicked-garden", marketplace: "wicked-garden", addedByInstaller: owned } }]);
      stub(w, "codex", `'${join(ROOT, "tests/codex-stub.mjs")}' "$@"`);
      writeFileSync(join(m.home, "stub-state.json"), JSON.stringify({ marketplaces: { "wicked-garden": { sourceType: "github", source: "acme/garden" } }, plugins: { "wicked-garden@wicked-garden": { version: "1" } } }));
      if (shared) {
        const body = JSON.parse(readFileSync(m.file, "utf8"));
        body.products.push({ ...entry("wicked-bus"), codexPlugin: { pluginId: "wicked-bus@wicked-garden", marketplace: "wicked-garden", addedByInstaller: false } });
        writeFileSync(m.file, JSON.stringify(body));
      }
      const log = join(w.home, "calls");
      const before = readFileSync(m.file, "utf8");
      const dry = run(w, "codex", ["uninstall", "wicked-garden", "--dry-run", "--json"], { CODEX_STUB_LOG: log });
      assert.equal(dry.status, 0, dry.out); assert.equal(readFileSync(m.file, "utf8"), before);
      assert.ok(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).every(c => !c.argv.includes("remove")));
      const failure = run(w, "codex", ["uninstall", "wicked-garden", "--json"], { CODEX_STUB_LOG: log, CODEX_STUB_FAIL: "plugin-remove" });
      assert.equal(failure.status, 1, failure.out);
      assert.match(JSON.parse(readFileSync(m.file, "utf8")).products.find(p => p.id === "wicked-garden").lastFailure.message, /plugin remove/);
      writeFileSync(log, "");
      const r = run(w, "codex", ["uninstall", "wicked-garden", "--json"], { CODEX_STUB_LOG: log }); assert.equal(r.status, 0, r.out);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse); assert.ok(calls.every(c => c.home === m.home));
      const mutations = calls.filter(c => c.argv.includes("remove")).map(c => c.argv);
      assert.deepEqual(mutations, [["plugin", "remove", "wicked-garden@wicked-garden"], ...(owned && !shared ? [["plugin", "marketplace", "remove", "wicked-garden"]] : [])]);
    } finally { rmSync(w.home, { recursive: true, force: true }); }
  }
});

test("uninstall opencode: removes only a direct product binary registration", () => {
  for (const command of ["wicked-estate-mcp", "user-wrapper"]) {
    const w = world();
    try {
      const m = marker(w, "opencode", [entry("wicked-estate")]);
      const file = join(m.home, "opencode.json");
      const original = "// user config comment\n" + JSON.stringify({ mcp: { servers: { "wicked-estate": { type: "local", command: [`/bin/${command}`] } } }, skills: { paths: [m.skills] } });
      writeFileSync(file, original);
      const r = run(w, "opencode", ["uninstall", "--all", "--json"]); assert.equal(r.status, 0, r.out);
      const after = readFileSync(file, "utf8");
      if (command === "user-wrapper") {
        assert.equal(after, original);
        assert.doesNotMatch(json(r).reports[0].message, /comments dropped/);
      } else {
        assert.equal(JSON.parse(after).mcp.servers["wicked-estate"], undefined);
        assert.deepEqual(JSON.parse(after).skills.paths, [m.skills]);
        assert.doesNotMatch(after, /user config comment/);
        assert.match(json(r).reports[0].message, /config rewritten as JSON; JSONC comments dropped/);
      }
      assert.match(JSON.stringify(json(r)), command === "user-wrapper" ? /manual/ : /skills.paths/);
    } finally { rmSync(w.home, { recursive: true, force: true }); }
  }
});

test("central uninstall: human output has host headers, report statuses and path counts", () => {
  const w = world();
  try {
    const names = ["wicked-garden-one", "wicked-garden-two", "wicked-garden-three"];
    const m = marker(w, "pi", [entry("wicked-garden", names)]);
    for (const name of names) skill(m.skills, name);
    const r = run(w, "central", ["uninstall", "wicked-garden", "wicked-estate", "--cli", "pi"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^pi:\n  \[ok\] wicked-garden: uninstalled from Pi\n    removed 3 path\(s\)\n/m);
    assert.match(r.stdout, /^    Binaries are machine-scoped and shared across CLIs; left in place\.$/m);
    assert.match(r.stdout, /^  \[skipped\] wicked-estate: not installed on Pi\n    removed 0 path\(s\)$/m);
    assert.ok(!r.stdout.includes(m.skills), "human output omits the removed path list");
    for (const name of names) assert.ok(!r.stdout.includes(name));
  } finally { rmSync(w.home, { recursive: true, force: true }); }
});

test("uninstall codex: failed CLI output is capped at 300 characters and the entry is kept", () => {
  const w = world();
  try {
    const m = marker(w, "codex", [{ ...entry("wicked-garden"), codexPlugin: { pluginId: "wicked-garden@wicked-garden", marketplace: "wicked-garden", addedByInstaller: false } }]);
    const cliStub = join(w.home, "noisy-codex.mjs");
    writeFileSync(cliStub, `
      if (process.argv[3] === "list") console.log(JSON.stringify({ installed: [{ pluginId: "wicked-garden@wicked-garden" }] }));
      else { console.error("x".repeat(1000) + "omitted-tail"); process.exitCode = 1; }
    `);
    stub(w, "codex", `'${cliStub}' "$@"`);
    const r = run(w, "codex", ["uninstall", "--all", "--json"]);
    assert.equal(r.status, 1, r.out);
    const report = json(r).reports[0];
    assert.equal(report.message, `wicked-garden: codex plugin remove wicked-garden@wicked-garden failed: ${"x".repeat(300)}`);
    assert.doesNotMatch(r.out, /omitted-tail/);
    assert.equal(JSON.parse(readFileSync(m.file, "utf8")).products[0].lastFailure.message, report.message);
    const human = run(w, "central", ["uninstall", "--all", "--cli", "codex"]);
    assert.equal(human.status, 1, human.out);
    assert.match(human.stdout, /^codex:\n  \[failed\] wicked-garden: codex plugin remove .*\n    removed 0 path\(s\)$/m);
    assert.doesNotMatch(human.out, /omitted-tail/);
  } finally { rmSync(w.home, { recursive: true, force: true }); }
});

test("central uninstall: dispatches all hosts and unregisters the Claude plugin with its config pinned", () => {
  const w = world();
  try {
    for (const cli of ["codex", "pi"]) { const m = marker(w, cli, [entry("wicked-garden", ["wicked-garden-one"])]); skill(m.skills, "wicked-garden-one"); }
    const cfg = join(w.home, ".claude"); mkdirSync(join(cfg, "plugins"), { recursive: true });
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", version: "1", installPath: join(cfg, "plugins/cache/wicked-garden/wicked-garden/1") }] } }));
    const log = join(w.home, "claude.log");
    stub(w, "claude", `'${join(ROOT, "tests/claude-stub.mjs")}' "$@"`);
    const r = run(w, "central", ["uninstall", "--all", "--json"], { CLAUDE_STUB_LOG: log }); assert.equal(r.status, 0, r.out);
    const result = json(r); assert.equal(result.verb, "uninstall"); assert.equal(result.hosts.length, 5);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(c => c.configDir === cfg && JSON.stringify(c.argv) === JSON.stringify(["plugin", "uninstall", "wicked-garden@wicked-garden"])));
    for (const cli of ["codex", "pi"]) assert.ok(!existsSync(join(w.home, hosts[cli], "skills/wicked-garden-one")));
    const empty = run(w, "central", ["uninstall"]); assert.equal(empty.status, 1, empty.out); assert.match(empty.out, /Usage:/);
  } finally { rmSync(w.home, { recursive: true, force: true }); }
});

test("uninstall codex: MCP removal requires a direct config entry and preserves plugin launchers", () => {
  for (const mode of ["config", "launcher", "plugin"]) {
    const w = world();
    try {
      const m = marker(w, "codex", [entry("wicked-estate")]);
      const log = join(w.home, "calls");
      const command = mode === "launcher" ? "wicked-garden" : "/bin/wicked-estate-mcp.exe";
      if (mode === "plugin") {
        const payload = join(w.home, "payload"); mkdirSync(join(payload, ".codex-plugin"), { recursive: true });
        writeFileSync(join(payload, ".codex-plugin/mcp.json"), JSON.stringify({ mcpServers: { "wicked-estate": { command } } }));
        writeFileSync(join(m.home, "stub-state.json"), JSON.stringify({ marketplaces: {}, plugins: { other: { path: payload } } }));
      } else writeFileSync(join(m.home, "config.toml"), `[mcp_servers.wicked-estate]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(mode === "launcher" ? ["run", "scripts/estate_mcp.mjs"] : [])}\n`);
      const r = run(w, "codex", ["uninstall", "--all", "--json"], { CODEX_STUB_LOG: log }); assert.equal(r.status, 0, r.out);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.some(c => c.argv[0] === "mcp" && c.argv[1] === "remove"), mode === "config", mode);
    } finally { rmSync(w.home, { recursive: true, force: true }); }
  }
});
