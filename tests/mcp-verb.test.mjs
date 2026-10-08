// mcp-verb.test.mjs — `wicked-installer mcp upsert|remove <key>` (INTERFACE.md §12.5).
//
// Every case runs the BUILT dispatcher (dist/index.js) in a sandbox: a temp HOME, a PATH holding
// only a `node` link plus stub `codex`/`opencode` executables that record their argv (and
// CODEX_HOME / XDG_CONFIG_HOME) to a log, so nothing on the host is read or written.
//
// Requires `npm run build` first (CI builds before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INDEX = join(ROOT, "dist", "index.js");
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "schemas", "install-report.schema.json"), "utf8"));
const POSIX = process.platform !== "win32";
const KEY = "acme-notes";
const SERVER = "/tmp/acme/dist/server.js";

// A stub CLI: records argv + the env var that selects its config root, keeps state in a JSON file.
const CODEX_STUB = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const home = process.env.CODEX_HOME;
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cli: "codex", argv: a, home }) + "\\n");
// like codex 0.160: a CODEX_HOME that does not exist is an error, for every subcommand
if (!fs.existsSync(home)) { process.stderr.write("Error: failed to resolve CODEX_HOME\\n"); process.exit(1); }
const sf = path.join(home, "stub-state.json");
const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {};
const save = () => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(sf, JSON.stringify(st)); };
if (a[0] !== "mcp") process.exit(64);
if (a[1] === "get") {
  const s = st[a[2]];
  if (!s) { process.stderr.write("Error: No MCP server named '" + a[2] + "' found.\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ name: a[2], enabled: true, transport: { type: "stdio", command: s.command, args: s.args, env: null, env_vars: [], cwd: null } }));
} else if (a[1] === "add") {
  const i = a.indexOf("--");
  st[a[2]] = { command: a[i + 1], args: a.slice(i + 2) }; save();
} else if (a[1] === "remove") {
  delete st[a[2]]; save();
} else process.exit(64);
`;

const OPENCODE_STUB = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cli: "opencode", argv: a, xdg: process.env.XDG_CONFIG_HOME }) + "\\n");
if (a[0] !== "mcp" || a[1] !== "add") process.exit(64);
const file = path.join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc");
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { $schema: "https://opencode.ai/config.json" };
const i = a.indexOf("--");
cfg.mcp = { ...(cfg.mcp || {}), [a[2]]: { type: "local", command: a.slice(i + 1) } };
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
`;

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-mcp-verb-"));
  const bin = join(tmp, "bin");
  const home = join(tmp, "home");
  mkdirSync(bin);
  mkdirSync(home);
  if (POSIX) {
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "codex"), CODEX_STUB);
    writeFileSync(join(bin, "opencode"), OPENCODE_STUB);
    chmodSync(join(bin, "codex"), 0o755);
    chmodSync(join(bin, "opencode"), 0o755);
  }
  const log = join(tmp, "stub.log");
  writeFileSync(log, "");
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: [bin, "/usr/bin", "/bin"].join(POSIX ? ":" : ";"), STUB_LOG: log };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG", "GEMINI_HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"]) delete env[k];
  const claudeHome = join(tmp, "claude-home");
  return {
    tmp,
    home,
    claudeHome,
    stateFile: join(claudeHome, ".claude.json"),
    markerFile: join(claudeHome, "wicked-installer", "claude-install.json"),
    run: (...args) => {
      const res = spawnSync(process.execPath, [INDEX, "mcp", ...args], { env, encoding: "utf8" });
      let json;
      try { json = JSON.parse(res.stdout); } catch { json = undefined; }
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

const upsertClaude = (sb, ...extra) => sb.run("upsert", KEY, "--command", "node", "--arg", SERVER, "--cli", "claude", "--claude-home", sb.claudeHome, "--json", ...extra);
const one = (r) => { assert.equal(r.json?.clis?.length, 1, r.stdout + r.stderr); return r.json.clis[0]; };

// ---- minimal draft-2020-12 subset validator (type/required/properties/enum/items/additionalProperties/$ref)
function validate(schema, value, root = SCHEMA, at = "$") {
  if (schema.$ref) return validate(schema.$ref.split("/").slice(1).reduce((o, k) => o[k], root), value, root, at);
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types.length && !types.some((t) => t === typeOf(value) || (t === "number" && typeof value === "number"))) return `${at}: type ${typeOf(value)} not in ${types}`;
  if (schema.enum && !schema.enum.includes(value)) return `${at}: ${JSON.stringify(value)} not in enum`;
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) return `${at}: does not match ${schema.pattern}`;
  if (typeOf(value) === "object") {
    for (const r of schema.required ?? []) if (!(r in value)) return `${at}: missing ${r}`;
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) { const e = validate(schema.properties[k], v, root, `${at}.${k}`); if (e) return e; }
      else if (schema.additionalProperties === false) return `${at}: unexpected ${k}`;
    }
  }
  if (typeOf(value) === "array" && schema.items) for (let i = 0; i < value.length; i += 1) { const e = validate(schema.items, value[i], root, `${at}[${i}]`); if (e) return e; }
  return undefined;
}
const assertEnvelope = (json) => assert.equal(validate(SCHEMA.$defs.mcpEnvelope, json), undefined);

test("claude: upsert writes the key, a backup and a json-key marker; a second identical upsert converges", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.claudeHome, { recursive: true });
    writeFileSync(sb.stateFile, JSON.stringify({ userState: { keep: true }, mcpServers: { other: { command: "x" } } }));
    const r1 = upsertClaude(sb);
    assert.equal(r1.status, 0, r1.stderr);
    assertEnvelope(r1.json);
    assert.equal(one(r1).result, "written");
    const state = JSON.parse(readFileSync(sb.stateFile, "utf8"));
    assert.deepEqual(state.mcpServers[KEY], { command: "node", args: [SERVER] });
    assert.deepEqual(state.userState, { keep: true });
    assert.deepEqual(state.mcpServers.other, { command: "x" });
    assert.equal(state.mcpServers[KEY].env, undefined, "no env is ever written");
    const backups = readdirSync(join(sb.claudeHome, "wicked-installer", "backups"));
    assert.equal(backups.filter((n) => n.startsWith(".claude.json.")).length, 1);
    const marker = JSON.parse(readFileSync(sb.markerFile, "utf8"));
    const rec = marker.products[`mcp-server:${KEY}`];
    assert.ok(rec, "synthetic product id recorded");
    assert.equal(rec.files[0].kind, "json-key");
    assert.equal(rec.files[0].pointer, `/mcpServers/${KEY}`);

    const before = [readFileSync(sb.stateFile, "utf8"), readFileSync(sb.markerFile, "utf8")];
    const r2 = upsertClaude(sb);
    assert.equal(r2.status, 0);
    assert.equal(one(r2).result, "converged");
    assert.deepEqual([readFileSync(sb.stateFile, "utf8"), readFileSync(sb.markerFile, "utf8")], before, "a converged run writes nothing");
  } finally { sb.cleanup(); }
});

test("claude: a changed command updates the entry this installer wrote", () => {
  const sb = sandbox();
  try {
    assert.equal(one(upsertClaude(sb)).result, "written");
    const r = sb.run("upsert", KEY, "--command", "/usr/local/bin/acme", "--arg", "--stdio", "--cli", "claude", "--claude-home", sb.claudeHome, "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(one(r).result, "updated");
    assert.deepEqual(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers[KEY], { command: "/usr/local/bin/acme", args: ["--stdio"] });
  } finally { sb.cleanup(); }
});

test("claude: a foreign entry is collision-skipped without --force and overwritten with it", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.claudeHome, { recursive: true });
    writeFileSync(sb.stateFile, JSON.stringify({ mcpServers: { [KEY]: { command: "theirs" } } }));
    const r1 = upsertClaude(sb);
    assert.equal(r1.status, 0, "skipped is not a failure");
    assert.equal(one(r1).result, "skipped");
    assert.match(one(r1).detail, /collision-skipped/);
    assert.deepEqual(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers[KEY], { command: "theirs" });
    const r2 = upsertClaude(sb, "--force");
    assert.equal(r2.status, 0);
    assert.equal(one(r2).result, "updated");
    assert.deepEqual(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers[KEY], { command: "node", args: [SERVER] });
    // remove restores the prior value --force recorded
    const r3 = sb.run("remove", KEY, "--cli", "claude", "--claude-home", sb.claudeHome, "--json");
    assert.equal(one(r3).result, "removed");
    assert.deepEqual(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers[KEY], { command: "theirs" });
  } finally { sb.cleanup(); }
});

test("claude: remove deletes only our key; a user-modified entry is skipped-modified; foreign keys are never removed", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.claudeHome, { recursive: true });
    writeFileSync(sb.stateFile, JSON.stringify({ mcpServers: { "keep-me": { command: "k" } } }));
    upsertClaude(sb);
    const r = sb.run("remove", KEY, "--cli", "claude", "--claude-home", sb.claudeHome, "--json");
    assert.equal(r.status, 0, r.stderr);
    assertEnvelope(r.json);
    assert.equal(one(r).result, "removed");
    const state = JSON.parse(readFileSync(sb.stateFile, "utf8"));
    assert.equal(state.mcpServers[KEY], undefined);
    assert.deepEqual(state.mcpServers["keep-me"], { command: "k" });
    assert.equal(existsSync(sb.markerFile), false, "the last marker record gone ⇒ marker removed");
    // foreign key with no marker record: never removed
    const f = sb.run("remove", "keep-me", "--cli", "claude", "--claude-home", sb.claudeHome, "--json");
    assert.equal(one(f).result, "skipped");
    assert.deepEqual(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers["keep-me"], { command: "k" });
    // modified after we wrote it
    upsertClaude(sb);
    const s = JSON.parse(readFileSync(sb.stateFile, "utf8"));
    s.mcpServers[KEY].args.push("--edited");
    writeFileSync(sb.stateFile, JSON.stringify(s));
    const m = sb.run("remove", KEY, "--cli", "claude", "--claude-home", sb.claudeHome, "--json");
    assert.equal(one(m).result, "skipped");
    assert.match(one(m).detail, /skipped-modified/);
    assert.ok(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers[KEY]);
  } finally { sb.cleanup(); }
});

test("claude: a corrupt .claude.json fails that CLI with the fix-or-remove sentence and stays byte-identical", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.claudeHome, { recursive: true });
    writeFileSync(sb.stateFile, "{ not json");
    const r = upsertClaude(sb);
    assert.equal(r.status, 1);
    assert.equal(one(r).result, "failed");
    assert.match(one(r).detail, /fix or remove .*\.claude\.json and re-run/);
    assert.equal(readFileSync(sb.stateFile, "utf8"), "{ not json");
    const rm = sb.run("remove", KEY, "--cli", "claude", "--claude-home", sb.claudeHome, "--json");
    assert.equal(one(rm).result, "failed");
    assert.equal(readFileSync(sb.stateFile, "utf8"), "{ not json");
  } finally { sb.cleanup(); }
});

test("claude: status and uninstall --all see the synthetic mcp-server:<key> product", () => {
  const sb = sandbox();
  try {
    upsertClaude(sb);
    const script = join(ROOT, "dist", "install-claude.js");
    const st = spawnSync(process.execPath, [script, "status", "--all", "--claude-home", sb.claudeHome, "--json"], { encoding: "utf8", env: { ...process.env, HOME: sb.home } });
    assert.equal(st.status, 0, st.stderr);
    const ids = JSON.parse(st.stdout).reports.map((r) => r.productId);
    assert.ok(ids.includes(`mcp-server:${KEY}`), ids.join(","));
    const un = spawnSync(process.execPath, [script, "uninstall", "--all", "--claude-home", sb.claudeHome, "--json"], { encoding: "utf8", env: { ...process.env, HOME: sb.home } });
    assert.equal(un.status, 0, un.stderr);
    assert.equal(JSON.parse(readFileSync(sb.stateFile, "utf8")).mcpServers[KEY], undefined);
  } finally { sb.cleanup(); }
});

test("--dry-run prints planned entries and writes nothing", { skip: !POSIX && "stub CLIs are POSIX scripts" }, () => {
  const sb = sandbox();
  try {
    const codexHome = join(sb.tmp, "codex-home");
    const r = sb.run("upsert", KEY, "--command", "node", "--arg", SERVER, "--cli", "claude,codex,opencode", "--claude-home", sb.claudeHome,
      "--codex-home", codexHome, "--opencode-home", join(sb.tmp, "cfg", "opencode"), "--dry-run", "--json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assertEnvelope(r.json);
    assert.deepEqual(r.json.clis.map((c) => c.result), ["planned", "planned", "planned"]);
    assert.equal(existsSync(sb.claudeHome), false);
    assert.equal(existsSync(codexHome), false);
    assert.equal(existsSync(join(sb.tmp, "cfg")), false);
    assert.ok(sb.calls().every((c) => c.argv[1] === "get"), "only read-only probes ran");
  } finally { sb.cleanup(); }
});

test("codex: mcp add / get / remove through the CLI, drift repaired, action recorded in the v1 marker", { skip: !POSIX && "stub CLIs are POSIX scripts" }, () => {
  const sb = sandbox();
  try {
    const codexHome = join(sb.tmp, "codex-home");
    const up = (...args) => sb.run("upsert", KEY, "--command", "node", ...args, "--cli", "codex", "--codex-home", codexHome, "--json");
    const r1 = up("--arg", SERVER);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assertEnvelope(r1.json);
    assert.equal(one(r1).result, "written");
    assert.ok(sb.calls().some((c) => c.home === codexHome && JSON.stringify(c.argv) === JSON.stringify(["mcp", "add", KEY, "--", "node", SERVER])));
    const marker = JSON.parse(readFileSync(join(codexHome, "wicked-installer", "codex-install.json"), "utf8"));
    const rec = marker.products.find((p) => p.id === `mcp-server:${KEY}`);
    assert.ok(rec && /codex mcp add acme-notes -- node/.test(rec.notes[0]));
    assert.deepEqual(Object.keys(rec).sort(), ["assets", "id", "notes", "skipped", "success"], "v1 marker shape unchanged");

    const n = sb.calls().length;
    assert.equal(one(up("--arg", SERVER)).result, "converged");
    assert.ok(sb.calls().slice(n).every((c) => c.argv[1] === "get"), "converged run adds nothing");

    const r3 = up("--arg", SERVER, "--arg", "--verbose");
    assert.equal(one(r3).result, "updated");
    const tail = sb.calls().slice(-2).map((c) => c.argv.slice(0, 3).join(" "));
    assert.deepEqual(tail, [`mcp remove ${KEY}`, `mcp add ${KEY}`]);

    const r4 = sb.run("remove", KEY, "--cli", "codex", "--codex-home", codexHome, "--json");
    assert.equal(one(r4).result, "removed");
    assert.equal(JSON.parse(readFileSync(join(codexHome, "wicked-installer", "codex-install.json"), "utf8")).products.length, 0);
    assert.equal(one(sb.run("remove", KEY, "--cli", "codex", "--codex-home", codexHome, "--json")).result, "skipped");
  } finally { sb.cleanup(); }
});

test("opencode: mcp add via the CLI, converge read from its config, remove is manual, numeric args are manual", { skip: !POSIX && "stub CLIs are POSIX scripts" }, () => {
  const sb = sandbox();
  try {
    const ocHome = join(sb.tmp, "cfg", "opencode");
    const r1 = sb.run("upsert", KEY, "--command", "node", "--arg", SERVER, "--cli", "opencode", "--opencode-home", ocHome, "--json");
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assertEnvelope(r1.json);
    assert.equal(one(r1).result, "written");
    const call = sb.calls().find((c) => c.cli === "opencode");
    assert.deepEqual(call.argv, ["mcp", "add", KEY, "--", "node", SERVER]);
    assert.equal(call.xdg, join(sb.tmp, "cfg"));
    const r2 = sb.run("upsert", KEY, "--command", "node", "--arg", SERVER, "--cli", "opencode", "--opencode-home", ocHome, "--json");
    assert.equal(one(r2).result, "converged");
    assert.equal(sb.calls().filter((c) => c.cli === "opencode").length, 1);
    const rm = sb.run("remove", KEY, "--cli", "opencode", "--opencode-home", ocHome, "--json");
    assert.equal(rm.status, 0);
    assert.equal(one(rm).result, "manual");
    assert.match(one(rm).detail, /delete the "acme-notes" entry under "mcp" in .*opencode\.jsonc/);
    const num = sb.run("upsert", "acme-two", "--command", "node", "--arg", SERVER, "--arg", "3000", "--cli", "opencode", "--opencode-home", ocHome, "--json");
    assert.equal(one(num).result, "manual");
    assert.match(one(num).detail, /numeric-looking/);
    assert.equal(sb.calls().filter((c) => c.cli === "opencode").length, 1, "never spawned for a numeric arg");
  } finally { sb.cleanup(); }
});

test("pi and antigravity report unsupported and exit 0", () => {
  const sb = sandbox();
  try {
    const r = sb.run("upsert", KEY, "--command", "node", "--cli", "pi,antigravity", "--pi-home", join(sb.tmp, "pi"), "--gemini-home", join(sb.tmp, "gemini"), "--json");
    assert.equal(r.status, 0, r.stderr);
    assertEnvelope(r.json);
    assert.deepEqual(r.json.clis.map((c) => [c.cli, c.result]), [["pi", "unsupported"], ["antigravity", "unsupported"]], "in --cli order");
    assert.match(r.json.clis[1].detail, /no stated MCP target \(INTERFACE §8\.3\)/);
    assert.equal(existsSync(join(sb.tmp, "pi")), false);
    assert.equal(existsSync(join(sb.tmp, "gemini")), false);
  } finally { sb.cleanup(); }
});

test("bad arguments exit 2", () => {
  const sb = sandbox();
  try {
    const cases = [
      ["upsert", "Acme", "--command", "node"],
      ["upsert", "1acme", "--command", "node"],
      ["upsert", "a".repeat(65), "--command", "node"],
      ["upsert", KEY],
      ["upsert", KEY, "--command", "./relative/server"],
      ["upsert", KEY, "--command", "node", "--cli", "vim"],
      ["upsert", KEY, "--command", "node", "--env", "TOKEN=x"],
      ["upsert", KEY, "--command", "node", "--bogus"],
      ["install", KEY],
    ];
    for (const c of cases) {
      const r = sb.run(...c, "--json");
      assert.equal(r.status, 2, `${c.join(" ")} → ${r.status} ${r.stderr}`);
    }
    assert.equal(sb.run("upsert", KEY, "--command").status, 2, "a value flag with no value");
    assert.equal(existsSync(sb.claudeHome), false);
  } finally { sb.cleanup(); }
});

test("--help names the no-env rule", () => {
  const sb = sandbox();
  try {
    const r = sb.run("--help");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No --env/);
  } finally { sb.cleanup(); }
});
