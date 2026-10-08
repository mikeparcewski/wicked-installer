// legacy-cleanup.test.mjs — `wicked-installer cleanup-legacy` (#20, INTERFACE.md §12.6) removes the
// legacy wicked-garden copies ONLY where ownership is proven, and nothing at all when it is not.
// Asserted on the BUILT modules (dist/). Requires `npm run build` first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { cleanupDir } = await import(join(ROOT, "dist", "legacy-cleanup.js"));
const { claudePluginSpec } = await import(join(ROOT, "dist", "claude-plugin.js"));
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "schemas", "install-report.schema.json"), "utf8"));
const spec = claudePluginSpec({ id: "wicked-garden", install: { marketplace: "mikeparcewski/wicked-garden", pluginId: "wicked-garden@wicked-garden" } });
const WIN = process.platform === "win32";
const OWNER = "wicked-installer/products/wicked-garden";

const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const hash = (v) => `sha256:${createHash("sha256").update(JSON.stringify(canon(v))).digest("hex")}`;

/** Every path under `dir` with its type and (for files) content hash, links by target — a byte-level snapshot. */
function snapshot(dir) {
  const out = {};
  const visit = (p, rel) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(p)}`;
    else if (st.isDirectory()) { out[rel] = "dir"; for (const n of readdirSync(p).sort()) visit(join(p, n), `${rel}/${n}`); }
    else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
  };
  visit(dir, ".");
  return out;
}

const SERVER = { command: "wicked-garden-mcp", args: [] };

/** A config dir: optionally registered, with a bare copy and the records an earlier install-claude.js left. */
function fixture({ registered = true, records } = {}) {
  const base = mkdtempSync(join(tmpdir(), "wicked-legacy-"));
  const cfg = join(base, "cfg");
  const plugins = join(cfg, "plugins");
  mkdirSync(plugins, { recursive: true });
  if (registered) {
    const installPath = join(plugins, "cache", "wicked-garden", "wicked-garden", "1.0.0");
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ "wicked-garden": { source: { source: "github", repo: "mikeparcewski/wicked-garden" } } }));
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "wicked-garden@wicked-garden": [{ scope: "user", installPath, version: "1.0.0" }] } }));
    mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "1.0.0" }));
  }
  // the bare copy `npx wicked-garden install` wrote
  mkdirSync(join(plugins, "wicked-garden", ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugins, "wicked-garden", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version: "0.9.0" }));
  // the copies an earlier install-claude.js recorded
  mkdirSync(join(cfg, "skills", "wicked-garden-mem"), { recursive: true });
  writeFileSync(join(cfg, "skills", "wicked-garden-mem", "SKILL.md"), "---\nname: wicked-garden-mem\n---\nwicked-garden memory skill\n");
  mkdirSync(join(cfg, "skills", "user-own"), { recursive: true });
  writeFileSync(join(cfg, "skills", "user-own", "SKILL.md"), "mine\n");
  mkdirSync(join(cfg, OWNER, "hooks"), { recursive: true });
  writeFileSync(join(cfg, OWNER, "hooks", "h.js"), "//\n");
  const ourHook = { matcher: "*", hooks: [{ type: "command", command: `node ${join(cfg, OWNER, "hooks", "h.js")}` }] };
  const userHook = { matcher: "*", hooks: [{ type: "command", command: "echo mine" }] };
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "dark", hooks: { PreToolUse: [userHook, ourHook] } }));
  writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ userState: 1, mcpServers: { "wicked-garden": SERVER, "user-server": { command: "u" } } }));
  const files = records ?? [
    { kind: "dir", path: "skills/wicked-garden-mem" },
    { kind: "dir", path: OWNER },
    { kind: "hooks-entry", file: "settings.json", event: "PreToolUse", ownerMatch: { commandContains: OWNER } },
    { kind: "json-key", file: ".claude.json", pointer: "/mcpServers/wicked-garden", wroteHash: hash(SERVER), prior: null },
  ];
  mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
  writeFileSync(join(cfg, "wicked-installer", "claude-install.json"), JSON.stringify({
    markerVersion: 2, cli: "claude", configDir: cfg, updatedAt: "2026-01-01T00:00:00Z",
    products: {
      "wicked-garden": { installedAt: "2026-01-01T00:00:00Z", lastResult: "installed", files, notes: [] },
      "wicked-bus": { installedAt: "2026-01-01T00:00:00Z", lastResult: "installed", files: [], notes: [] },
    },
  }, null, 2));
  return { base, cfg, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("legitimate garden-owned entries are removed exactly; the marker record is dropped; dry-run first writes nothing", () => {
  const fx = fixture();
  try {
    const before = snapshot(fx.base);
    const dry = cleanupDir(fx.cfg, spec, true);
    assert.equal(dry.result, "planned", JSON.stringify(dry, null, 1));
    assert.ok(dry.removals.every((r) => r.result === "planned"));
    assert.deepEqual(snapshot(fx.base), before, "dry run writes nothing");

    const r = cleanupDir(fx.cfg, spec, false);
    assert.equal(r.result, "cleaned", JSON.stringify(r, null, 1));
    assert.equal(existsSync(join(fx.cfg, "plugins", "wicked-garden")), false, "bare copy removed");
    assert.equal(existsSync(join(fx.cfg, "skills", "wicked-garden-mem")), false);
    assert.equal(existsSync(join(fx.cfg, OWNER)), false);
    assert.ok(existsSync(join(fx.cfg, "skills", "user-own", "SKILL.md")), "user skill untouched");
    assert.ok(existsSync(join(fx.cfg, "plugins", "cache", "wicked-garden", "wicked-garden", "1.0.0")), "the registered payload untouched");
    const settings = JSON.parse(readFileSync(join(fx.cfg, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.hooks.PreToolUse.map((g) => g.hooks[0].command), ["echo mine"]);
    const state = JSON.parse(readFileSync(join(fx.cfg, ".claude.json"), "utf8"));
    assert.deepEqual(Object.keys(state.mcpServers), ["user-server"]);
    assert.equal(state.userState, 1);
    const marker = JSON.parse(readFileSync(join(fx.cfg, "wicked-installer", "claude-install.json"), "utf8"));
    assert.deepEqual(Object.keys(marker.products), ["wicked-bus"], "only the garden record is dropped");
    assert.ok(readdirSync(join(fx.cfg, "wicked-installer", "backups")).length >= 2, "config files backed up before the rewrite");
    // idempotent: a second run has nothing to do
    assert.equal(cleanupDir(fx.cfg, spec, false).result, "nothing");
  } finally { fx.cleanup(); }
});

test("registration not `registered` → nothing removed, reported blocked", () => {
  const fx = fixture({ registered: false });
  try {
    const before = snapshot(fx.base);
    const r = cleanupDir(fx.cfg, spec, false);
    assert.equal(r.result, "blocked", JSON.stringify(r.removals));
    assert.ok(r.removals.every((m) => m.result === "kept"));
    assert.deepEqual(snapshot(fx.base), before);
  } finally { fx.cleanup(); }
});

test("poisoned marker → every bad entry refused, nothing touched inside or outside the dir, marker preserved, failed", () => {
  const records = [
    { kind: "dir", path: "../outside" },
    { kind: "dir", path: "/etc" },
    { kind: "dir", path: "~/.claude" },
    { kind: "dir", path: "skills/../skills/wicked-garden-mem" },
    { kind: "dir", path: "skills/user-own" },
    { kind: "file", path: "settings.json" },
    { kind: "json-key", file: "~/.claude.json", pointer: "/mcpServers/wicked-garden", wroteHash: hash(SERVER) },
    { kind: "json-key", file: "../other/.claude.json", pointer: "/mcpServers/wicked-garden", wroteHash: hash(SERVER) },
    { kind: "json-key", file: ".claude.json", pointer: "/permissions", wroteHash: hash(SERVER) },
    { kind: "hooks-entry", file: "settings.json", event: "PreToolUse", ownerMatch: { commandContains: "" } },
    { kind: "hooks-entry", file: "settings.json", event: "PreToolUse", ownerMatch: { commandContains: "wicked-installer/products/wicked-bus" } },
    { kind: "hooks-entry", file: "settings.json", event: "../x", ownerMatch: { commandContains: OWNER } },
    { kind: "dir", path: "skills/wicked-garden-mem" }, // legitimate — must be KEPT because others were refused
  ];
  const fx = fixture({ records });
  try {
    mkdirSync(join(fx.base, "outside"));
    writeFileSync(join(fx.base, "outside", "keep"), "x");
    const before = snapshot(fx.base);
    const r = cleanupDir(fx.cfg, spec, false);
    assert.equal(r.result, "failed");
    const byTarget = (t) => r.removals.filter((m) => m.target.startsWith(t));
    for (const t of ["../outside", "/etc", "~/.claude", "skills/../", "skills/user-own", "settings.json#../x", "~/.claude.json", "../other", ".claude.json/permissions"]) {
      assert.ok(byTarget(t).length > 0 && byTarget(t).every((m) => m.result === "refused"), `${t}: ${JSON.stringify(byTarget(t))}`);
    }
    assert.equal(r.removals.filter((m) => m.kind === "hooks-entry" && m.result === "refused").length, 3);
    assert.ok(r.removals.some((m) => m.target === "skills/wicked-garden-mem" && m.result === "kept"));
    assert.ok(r.removals.some((m) => m.kind === "bare-copy" && m.result === "kept"));
    assert.deepEqual(snapshot(fx.base), before, "byte-identical: nothing removed, marker preserved");
  } finally { fx.cleanup(); }
});

test("symlinks anywhere below the config dir are refused, never followed", { skip: WIN && "symlink creation needs privileges on Windows" }, () => {
  for (const poison of ["settings.json", ".claude.json", "skills", "plugins/wicked-garden", "wicked-installer/claude-install.json"]) {
    const fx = fixture();
    try {
      const p = join(fx.cfg, poison);
      // move the real thing aside (inside the base, OUTSIDE the config dir) and link it back
      const real = join(fx.base, `real-${poison.replace(/[\\/]/g, "_")}`);
      renameSync(p, real);
      symlinkSync(real, p);
      const before = snapshot(fx.base);
      const r = cleanupDir(fx.cfg, spec, false);
      assert.notEqual(r.result, "cleaned", `${poison}: ${JSON.stringify(r)}`);
      assert.ok(r.removals.some((m) => m.result === "refused" && /symlink|outside/.test(m.detail)) || r.result === "blocked", `${poison}: ${JSON.stringify(r.removals)}`);
      assert.deepEqual(snapshot(fx.base), before, `${poison}: nothing touched`);
    } finally { fx.cleanup(); }
  }
});

test("CLI: exit 1 with a JSON envelope when refused; the default home's ~/.claude.json is untouched by a cleanup of another dir; exit 0 when cleaned", () => {
  const fx = fixture({ records: [{ kind: "json-key", file: "~/.claude.json", pointer: "/mcpServers/wicked-garden", wroteHash: hash(SERVER) }] });
  try {
    const home = join(fx.base, "home");
    mkdirSync(home);
    const homeState = JSON.stringify({ mcpServers: { "wicked-garden": SERVER } });
    writeFileSync(join(home, ".claude.json"), homeState);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CONFIG_DIR;
    const run = (...a) => spawnSync(process.execPath, [join(ROOT, "dist", "index.js"), "cleanup-legacy", ...a], { env, encoding: "utf8" });
    const r = run("--claude-home", fx.cfg, "--json");
    assert.equal(r.status, 1, r.stderr);
    const env1 = JSON.parse(r.stdout);
    assert.equal(env1.verb, "cleanup-legacy");
    assert.equal(validate(SCHEMA.$defs.cleanupLegacyEnvelope, env1), undefined);
    assert.equal(env1.dirs[0].result, "failed");
    assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), homeState);
    assert.equal(run("--bogus").status, 2);
  } finally { fx.cleanup(); }
  const ok = fixture();
  try {
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [join(ROOT, "dist", "index.js"), "cleanup-legacy", "--claude-home", ok.cfg, "--json"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).dirs[0].result, "cleaned");
  } finally { ok.cleanup(); }
});

// minimal draft-2020-12 subset validator (type/required/properties/enum/items/additionalProperties)
function validate(schema, value, at = "$") {
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (types.length && !types.includes(typeOf(value))) return `${at}: type ${typeOf(value)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${at}: ${JSON.stringify(value)} not in enum`;
  if (typeOf(value) === "object") {
    for (const r of schema.required ?? []) if (!(r in value)) return `${at}: missing ${r}`;
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) { const e = validate(schema.properties[k], v, `${at}.${k}`); if (e) return e; }
      else if (schema.additionalProperties === false) return `${at}: unexpected ${k}`;
    }
  }
  if (typeOf(value) === "array" && schema.items) for (let i = 0; i < value.length; i += 1) { const e = validate(schema.items, value[i], `${at}[${i}]`); if (e) return e; }
  return undefined;
}
