#!/usr/bin/env node
// Spawn-recording fake for the Codex CLI (put first on PATH as `codex`).
//
// Records every invocation — argv plus the CODEX_HOME it was handed — as one JSON line in
// $CODEX_STUB_LOG and keeps its state in $CODEX_HOME/stub-state.json, emulating only what
// install-codex drives: `plugin list --help`, `plugin marketplace list|add|remove`,
// `plugin list|add`, `mcp get|add|remove`. Output shapes were copied from codex-cli 0.163.0
// (`--json` variants). Effective MCP servers follow Codex's precedence: a config entry
// outranks a plugin's server of the same name; `mcp remove` acts on config only.
//
//   CODEX_STUB_NO_PLUGIN=1   behave like a codex without `codex plugin` (exit 2)
//   CODEX_STUB_FAIL=<sub>    make one subcommand exit 1: plugin-add | marketplace-add | mcp-add
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (process.env.CODEX_STUB_LOG) appendFileSync(process.env.CODEX_STUB_LOG, JSON.stringify({ argv, home: home ?? null }) + "\n");

const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
const fail = (msg, code = 1) => { process.stderr.write(msg + "\n"); process.exit(code); };

if (argv[0] === "--version") { out("codex-cli 0.163.0\n"); process.exit(0); }
if (argv[0] === "plugin" && process.env.CODEX_STUB_NO_PLUGIN === "1") fail("error: unrecognized subcommand 'plugin'", 2);
if (argv[0] === "plugin" && argv[1] === "list" && argv.includes("--help")) {
  out("List plugins\n\nOptions:\n  --json       Output plugin list as JSON.\n  --available  Include uninstalled marketplace plugins in the JSON output.\n");
  process.exit(0);
}
// The installer must pin CODEX_HOME on every call — the real CLI would otherwise act on ~/.codex.
if (!home) fail("codex-stub: CODEX_HOME not set", 3);
if (!existsSync(home)) fail(`Error: failed to resolve CODEX_HOME ${home}`, 1);

const stateFile = join(home, "stub-state.json");
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { marketplaces: {}, plugins: {}, mcp: {} };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const MKT = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"];
const marketplaceName = (root) => {
  for (const rel of MKT) { const m = readJson(join(root, rel)); if (m) return m.name; }
  return undefined;
};

function pluginServers() {
  const servers = {};
  for (const [id, p] of Object.entries(state.plugins)) {
    const mcp = readJson(join(p.path, ".codex-plugin", "mcp.json"));
    for (const [name, s] of Object.entries(mcp?.mcpServers ?? {})) servers[name] = { ...s, plugin: id };
  }
  return servers;
}

const [a0, a1, a2, a3] = argv;
if (a0 === "plugin" && a1 === "marketplace" && a2 === "list") {
  out({ marketplaces: Object.entries(state.marketplaces).map(([name, m]) => ({ name, root: m.source, marketplaceSource: { sourceType: "local", source: m.source } })) });
} else if (a0 === "plugin" && a1 === "marketplace" && a2 === "add") {
  if (process.env.CODEX_STUB_FAIL === "marketplace-add") fail("stub: marketplace add failed");
  const root = resolve(a3);
  const name = marketplaceName(root);
  if (!name) fail(`Error: marketplace root ${root} has no marketplace manifest`);
  const existing = state.marketplaces[name];
  if (existing && existing.source !== root) fail(`Error: marketplace '${name}' is already added from a different source; remove it before adding this source`);
  state.marketplaces[name] = { source: root };
  save();
  out({ marketplaceName: name, installedRoot: root, alreadyAdded: !!existing });
} else if (a0 === "plugin" && a1 === "marketplace" && a2 === "remove") {
  if (!state.marketplaces[a3]) fail(`Error: marketplace '${a3}' is not configured`);
  delete state.marketplaces[a3];
  save();
  out(`Removed marketplace \`${a3}\`.\n`);
} else if (a0 === "plugin" && a1 === "list") {
  out({ installed: Object.entries(state.plugins).map(([id, p]) => ({ pluginId: id, name: id.split("@")[0], marketplaceName: id.split("@")[1], version: p.version, installed: true, enabled: p.enabled !== false })), available: [] });
} else if (a0 === "plugin" && a1 === "add") {
  if (process.env.CODEX_STUB_FAIL === "plugin-add") fail("stub: plugin add failed");
  const [plugin, mkt] = a2.split("@");
  const m = state.marketplaces[mkt];
  if (!m) fail(`Error: marketplace '${mkt}' not found`);
  const manifest = readJson(join(m.source, ".codex-plugin", "plugin.json"));
  if (!manifest || manifest.name !== plugin) fail(`Error: plugin '${plugin}' not found in '${mkt}'`);
  const base = join(home, "plugins", "cache", mkt, plugin);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  cpSync(m.source, join(base, manifest.version), { recursive: true });
  state.plugins[a2] = { version: manifest.version, path: join(base, manifest.version), enabled: true };
  save();
  out({ pluginId: a2, name: plugin, marketplaceName: mkt, version: manifest.version, installedPath: join(base, manifest.version) });
} else if (a0 === "mcp" && a1 === "get") {
  const s = state.mcp[a2] ?? pluginServers()[a2];
  if (!s) fail(`Error: No MCP server named '${a2}' found.`);
  out({ name: a2, enabled: true, transport: { type: "stdio", command: s.command, args: s.args ?? [], env: s.env && Object.keys(s.env).length ? s.env : null, env_vars: [], cwd: null } });
} else if (a0 === "mcp" && a1 === "add") {
  if (process.env.CODEX_STUB_FAIL === "mcp-add") fail("stub: mcp add failed");
  const name = a2;
  const rest = argv.slice(3);
  const sep = rest.indexOf("--");
  const env = {};
  for (let i = 0; i < sep; i += 1) if (rest[i] === "--env") { const [k, ...v] = rest[i + 1].split("="); env[k] = v.join("="); i += 1; }
  const [command, ...args] = rest.slice(sep + 1);
  state.mcp[name] = { command, args, env };
  save();
  out(`Added global MCP server '${name}'.\n`);
} else if (a0 === "mcp" && a1 === "remove") {
  if (state.mcp[a2]) { delete state.mcp[a2]; save(); out(`Removed global MCP server '${a2}'.\n`); }
  else out(`No MCP server named '${a2}' found.\n`);
} else {
  fail(`codex-stub: unhandled ${argv.join(" ")}`, 9);
}
