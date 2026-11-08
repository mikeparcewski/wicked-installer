// first-run.test.mjs — what a clean-profile walk-through found (2026-11-08), one test per finding.
//
// B3/C5: readiness said "ready wicked-crew" while crew could see no wicked-garden (garden went to
//   Codex / the npm prefix, Claude Code's registration failed), so every launch was refused.
// C5: a failed Claude Code registration still left "ready wicked-garden — plugin hooks (Claude Code)".
// C5: the end message never said how to start Studio, and said "Done!" when crew could not run.
// C5: `status` before any install said "ready wicked-garden" (its only need, Python, was there).
// P11: the summary grid marked Bus and Crew "copied" under every CLI; the CLI prompt said
//   "legacy direct install".
// Requires `npm run build` first (CI builds before test). Filesystem fixtures only; nothing is run
// except the installer's own `status` under an isolated HOME and PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { findGardenForCrew } = await import("../dist/crew-garden.js");
const { preflight } = await import("../dist/readiness.js");
const { doneLine, crewStateOf, renderSummary, GRID_LEGEND, STUDIO_URL } = await import("../dist/index.js");
const { pathFix } = await import("../dist/release-binary.js");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const byId = Object.fromEntries(registry.products.map((p) => [p.id, p]));

const POSIX = process.platform !== "win32";
const skip = POSIX ? false : "fixtures use POSIX executables and symlinks";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function sandbox(t) {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-first-run-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const bin = join(tmp, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const env = { PATH: bin, HOME: home, USERPROFILE: home };
  const pluginRoot = (dir) => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"name":"wicked-garden","version":"12.66.0"}');
    return dir;
  };
  const exe = (dir, name) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return join(dir, name);
  };
  return { tmp, home, bin, env, pluginRoot, exe };
}

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const r = fn();
    return { r, out: strip(lines.join("\n")) };
  } finally {
    console.log = orig;
  }
}

// --- B3 / C5: garden crew can load --------------------------------------------------------

test("findGardenForCrew: nothing installed -> undefined; OpenCode skill copies are not a source", { skip }, (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.home, ".config", "opencode", "skills", "wicked-garden-core"), { recursive: true });
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined);
});

test("findGardenForCrew: a directory without .claude-plugin/plugin.json is not a garden", { skip }, (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.home, ".codex", "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"), { recursive: true });
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined);
});

test("findGardenForCrew: Codex plugin cache (CODEX_HOME honoured)", { skip }, (t) => {
  const sb = sandbox(t);
  const codexHome = join(sb.tmp, "codex-home");
  const dir = sb.pluginRoot(join(codexHome, "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined, "the default ~/.codex holds nothing");
  assert.deepEqual(findGardenForCrew({ ...sb.env, CODEX_HOME: codexHome }, "linux"), { path: dir, source: "Codex plugin cache" });
});

test("findGardenForCrew: the npm package behind the wicked-garden launcher on PATH", { skip }, (t) => {
  const sb = sandbox(t);
  const pkg = join(sb.tmp, "prefix", "lib", "node_modules", "wicked-garden");
  sb.pluginRoot(pkg);
  writeFileSync(join(pkg, "package.json"), '{"name":"wicked-garden"}');
  writeFileSync(join(pkg, "install.mjs"), "", { mode: 0o755 });
  symlinkSync(join(pkg, "install.mjs"), join(sb.bin, "wicked-garden"));
  const hit = findGardenForCrew(sb.env, "linux");
  assert.equal(hit?.source, "npm package (wicked-garden on PATH)");
});

test("findGardenForCrew: the wicked-garden package beside crew's global install", { skip }, (t) => {
  const sb = sandbox(t);
  const nm = join(sb.tmp, "prefix", "lib", "node_modules");
  const crew = join(nm, "wicked-crew");
  mkdirSync(join(crew, "dist"), { recursive: true });
  writeFileSync(join(crew, "package.json"), '{"name":"wicked-crew"}');
  writeFileSync(join(crew, "dist", "cli.js"), "", { mode: 0o755 });
  symlinkSync(join(crew, "dist", "cli.js"), join(sb.bin, "wicked-crew"));
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined);
  sb.pluginRoot(join(nm, "wicked-garden"));
  assert.equal(findGardenForCrew(sb.env, "linux")?.source, "npm package beside wicked-crew");
});

test("findGardenForCrew: Claude Code cache under CLAUDE_CONFIG_DIR, and a bad override is a miss", { skip }, (t) => {
  const sb = sandbox(t);
  const cfg = join(sb.tmp, "claude-cfg");
  const dir = sb.pluginRoot(join(cfg, "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  assert.deepEqual(findGardenForCrew({ ...sb.env, CLAUDE_CONFIG_DIR: cfg }, "linux"), { path: dir, source: "Claude Code plugin cache" });
  // crew reads ONLY the override when it is set.
  assert.equal(findGardenForCrew({ ...sb.env, CLAUDE_CONFIG_DIR: cfg, WICKED_CREW_SKILLS_SOURCE: join(sb.tmp, "nope") }, "linux"), undefined);
});

test("first-run B3/C5: crew readiness is PENDING while crew sees no garden, uv or estate — and names each fix", { skip }, (t) => {
  const sb = sandbox(t);
  sb.exe(sb.bin, "wicked-crew");
  const crew = byId["wicked-crew"];
  const pending = preflight([crew], { env: sb.env, platform: "linux", probeOnly: true }).find((r) => r.capability === "daemon");
  assert.equal(pending.state, "pending");
  const unmet = Object.fromEntries(pending.needs.filter((n) => !n.met).map((n) => [n.need, n.remedy]));
  assert.deepEqual(Object.keys(unmet).sort(), ["backend wicked-estate", "uv", "wicked-garden for crew"]);
  assert.equal(unmet["backend wicked-estate"], "npx wicked-installer install wicked-estate");
  assert.equal(unmet["wicked-garden for crew"], "npm i -g wicked-garden");

  const local = join(sb.home, ".local", "bin");
  sb.exe(local, "uv");
  sb.exe(local, "wicked-estate");
  sb.pluginRoot(join(sb.home, ".codex", "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  const ready = preflight([crew], { env: sb.env, platform: "linux", probeOnly: true }).find((r) => r.capability === "daemon");
  assert.equal(ready.state, "ready", JSON.stringify(ready.needs));
});

// --- C5: per-product hosts ----------------------------------------------------------------

test("first-run C5: a host whose delivery failed gets no host-scoped readiness row", () => {
  const garden = byId["wicked-garden"];
  const all = preflight([garden], { hosts: ["claude", "codex"], probeOnly: true, platform: "linux", env: { PATH: "" } });
  assert.ok(all.some((r) => r.capability === "plugin-scripts"), "control: Claude Code's row exists when Claude Code is a delivered host");
  const rows = preflight([garden], { hosts: ["claude", "codex"], hostsFor: () => ["codex"], probeOnly: true, platform: "linux", env: { PATH: "" } });
  assert.ok(!rows.some((r) => r.capability === "plugin-scripts"), "garden was not delivered to Claude Code: no plugin-hooks row for it");
  assert.ok(rows.some((r) => r.capability === "skill-scripts"), "Codex delivery is still checked");
});

// --- C5: the end message ------------------------------------------------------------------

test("first-run C5: with crew ready, the end message says exactly how to start Studio", () => {
  const out = strip(doneLine({ dryRun: false }, 0, "ready"));
  assert.match(out, /wicked-crew serve/);
  assert.match(out, /npx wicked-crew serve/);
  assert.ok(out.includes(STUDIO_URL) && STUDIO_URL === "http://127.0.0.1:7701", out);
});

test("first-run C5: never 'Done!' while crew's needs are pending; the start step still shown for after", () => {
  const out = strip(doneLine({ dryRun: false }, 1, "pending"));
  assert.doesNotMatch(out, /Done!/);
  assert.match(out, /can't run jobs yet/);
  assert.match(out, /wicked-crew serve/);
});

test("crewStateOf: absent without crew; pending on any non-ready crew row", () => {
  const row = (state) => ({ productId: "wicked-crew", capability: "daemon", label: "", optional: false, state, needs: [] });
  assert.equal(crewStateOf(["wicked-bus"], [row("pending")]), "absent");
  assert.equal(crewStateOf(["wicked-crew"], [row("ready")]), "ready");
  assert.equal(crewStateOf(["wicked-crew"], [row("pending")]), "pending");
  assert.equal(crewStateOf(["wicked-crew"], [row("unchecked")]), "pending");
  assert.match(strip(doneLine({ dryRun: false }, 0, "absent")), /Start your coding agent/);
});

// --- P11: wording --------------------------------------------------------------------------

test("first-run P11: the grid says 'skills added', not 'copied', and explains its words once", () => {
  const results = ["Claude Code", "Codex"].map((displayName, i) => ({
    cli: i === 0 ? "claude" : "codex", displayName, present: true, parsed: true, status: 0,
    entries: [{ productId: "wicked-bus", displayName: "Wicked Bus", success: true, skipped: false, delivery: "copied", message: "" }],
  }));
  const { r, out } = captureLog(() => renderSummary(results, ["wicked-bus"]));
  assert.equal(r, false);
  assert.doesNotMatch(out, /\bcopied\b/);
  assert.match(out, /Wicked Bus\s+skills added\s+skills added/);
  assert.ok(out.includes(GRID_LEGEND));
});

test("first-run P11: a plugin's note does not repeat its name ('Wicked Garden: Wicked Garden: …')", () => {
  const results = [{
    cli: "codex", displayName: "Codex", present: true, parsed: true, status: 0,
    entries: [{ productId: "wicked-garden", displayName: "Wicked Garden", success: true, skipped: false, delivery: "registered", message: "Wicked Garden: registered as Codex plugin" }],
  }];
  const { out } = captureLog(() => renderSummary(results, ["wicked-garden"]));
  assert.match(out, /Wicked Garden: registered as Codex plugin/);
  assert.doesNotMatch(out, /Wicked Garden: Wicked Garden:/);
});

test("first-run P11: the CLI prompt has no 'legacy direct install' jargon", () => {
  const ui = readFileSync(join(root, "dist", "ui.js"), "utf8");
  assert.doesNotMatch(ui, /legacy direct install/);
  assert.match(ui, /select none to install only the command-line tools/);
});

test("first-run C8: the PATH fix on macOS writes to ~/.zprofile (zsh never reads ~/.profile)", () => {
  assert.match(pathFix("/x/.local/bin", "darwin"), /~\/\.zprofile/);
  assert.match(pathFix("/x/.local/bin", "linux"), /~\/\.profile/);
});

// --- C5: status before install ------------------------------------------------------------

test("first-run C5: `status` on a clean machine reports no capability of an uninstalled product as ready", { skip }, (t) => {
  const sb = sandbox(t);
  // Only node on PATH: no CLI, no python3 reachable through the fixture PATH.
  symlinkSync(process.execPath, join(sb.bin, "node"));
  const res = spawnSync(process.execPath, [join(root, "dist", "index.js"), "status", "--offline"], {
    env: { ...sb.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = strip(`${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(out, /ready\s+wicked-garden/, out);
  assert.doesNotMatch(out, /ready\s+wicked-crew/, out);
  assert.match(out, /Capabilities not checked \(product not installed\): .*wicked-garden/, out);
});
