#!/usr/bin/env node
// Spawn-recording fake for the Claude Code CLI (the WICKED_CLAUDE_BIN target).
//
// Records every invocation — argv plus the CLAUDE_CONFIG_DIR it was handed — as one JSON line in
// $CLAUDE_STUB_LOG, and emulates the on-disk effects the real CLI has, INSIDE CLAUDE_CONFIG_DIR
// only: plugins/known_marketplaces.json, plugins/installed_plugins.json and
// plugins/cache/<marketplace>/<plugin>/<version>/. Output shapes were copied from Claude Code
// 2.1.267 (`claude plugin marketplace list --json`, `claude plugin list --json`).
//
//   CLAUDE_STUB_VERSION  the version it "installs" (default 0.0.1-stub)
//   CLAUDE_STUB_FAIL     make one subcommand exit 1: version | add | install | update | list
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (process.env.CLAUDE_STUB_LOG) {
  appendFileSync(process.env.CLAUDE_STUB_LOG, JSON.stringify({ argv, configDir: configDir ?? null }) + "\n");
}

if (argv[0] === "--version") {
  // A present-but-broken Claude Code: the installer must treat this as an error, not "absent".
  if (process.env.CLAUDE_STUB_FAIL === "version") {
    process.stderr.write("stub: claude is broken\n");
    process.exit(1);
  }
  process.stdout.write("9.9.9 (Claude Code stub)\n");
  process.exit(0);
}

// The installer must pin CLAUDE_CONFIG_DIR on every plugin call — without it the real CLI would
// act on the operator's own config. Fail loud rather than emulate anything.
if (!configDir) {
  process.stderr.write("claude-stub: CLAUDE_CONFIG_DIR not set\n");
  process.exit(3);
}

const pluginsDir = join(configDir, "plugins");
const marketplacesFile = join(pluginsDir, "known_marketplaces.json");
const installedFile = join(pluginsDir, "installed_plugins.json");
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => {
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};
const failing = (what) => process.env.CLAUDE_STUB_FAIL === what;
const version = process.env.CLAUDE_STUB_VERSION ?? "0.0.1-stub";
const now = new Date().toISOString();

const [group, sub, third, ...rest] = argv;
if (group !== "plugin") {
  process.stderr.write(`claude-stub: unknown command: ${argv.join(" ")}\n`);
  process.exit(2);
}

if (sub === "marketplace" && third === "list") {
  if (failing("list")) { process.stderr.write("stub: marketplace list failed\n"); process.exit(1); }
  const known = readJson(marketplacesFile, {});
  const rows = Object.entries(known).map(([name, m]) => ({
    name,
    source: m.source.source,
    ...(m.source.repo ? { repo: m.source.repo } : {}),
    ...(m.source.path ? { path: m.source.path } : {}),
    installLocation: m.installLocation,
  }));
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  process.exit(0);
}

if (sub === "marketplace" && third === "add") {
  if (failing("add")) { process.stderr.write("stub: marketplace add failed\n"); process.exit(1); }
  const source = rest[0];
  const isDir = existsSync(source);
  let name = basename(source);
  if (isDir) {
    const manifest = join(source, ".claude-plugin", "marketplace.json");
    if (existsSync(manifest)) name = JSON.parse(readFileSync(manifest, "utf8")).name ?? name;
  }
  const known = readJson(marketplacesFile, {});
  known[name] = {
    source: isDir ? { source: "directory", path: resolve(source) } : { source: "github", repo: source },
    installLocation: isDir ? resolve(source) : join(pluginsDir, "marketplaces", name),
    lastUpdated: now,
  };
  writeJson(marketplacesFile, known);
  process.stdout.write(`Adding marketplace…✔ Successfully added marketplace: ${name} (declared in user settings)\n`);
  process.exit(0);
}

if (sub === "list") {
  if (failing("list")) { process.stderr.write("stub: plugin list failed\n"); process.exit(1); }
  const installed = readJson(installedFile, { version: 2, plugins: {} });
  const rows = Object.entries(installed.plugins).flatMap(([id, entries]) =>
    entries.map((e) => ({ id, version: e.version, scope: e.scope, enabled: true, installPath: e.installPath, installedAt: e.installedAt, lastUpdated: e.lastUpdated })),
  );
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  process.exit(0);
}

if (sub === "install" || sub === "update") {
  if (failing(sub)) { process.stderr.write(`stub: plugin ${sub} failed\n`); process.exit(1); }
  const id = third;
  const [name, marketplace] = id.split("@");
  const known = readJson(marketplacesFile, {});
  if (!marketplace || !known[marketplace]) {
    process.stderr.write(`Marketplace not found: ${marketplace ?? "(none)"}\n`);
    process.exit(1);
  }
  const installed = readJson(installedFile, { version: 2, plugins: {} });
  if (sub === "update" && !installed.plugins[id]) {
    process.stderr.write(`Plugin not installed: ${id}\n`);
    process.exit(1);
  }
  const installPath = join(pluginsDir, "cache", marketplace, name, version);
  mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
  writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
  const prior = installed.plugins[id]?.[0];
  installed.plugins[id] = [{
    scope: "user",
    installPath,
    version,
    installedAt: prior?.installedAt ?? now,
    lastUpdated: now,
    gitCommitSha: "stub",
  }];
  writeJson(installedFile, installed);
  process.stdout.write(sub === "install"
    ? `Installing plugin "${id}"...✔ Successfully installed plugin: ${id} (scope: user)\n`
    : `✔ ${name} updated to ${version}\n`);
  process.exit(0);
}

process.stderr.write(`claude-stub: unknown command: ${argv.join(" ")}\n`);
process.exit(2);
