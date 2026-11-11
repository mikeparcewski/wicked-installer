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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { findGardenForCrew, ensureGardenForCrew, crewGardenFloor } = await import("../dist/crew-garden.js");
const { preflight } = await import("../dist/readiness.js");
const { doneLine, crewStateOf, renderSummary, directHostsFor, GRID_LEGEND, STUDIO_URL } = await import("../dist/index.js");
const { runUvInstaller, ensureUv } = await import("../dist/uv.js");
const { pathFix } = await import("../dist/release-binary.js");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const byId = Object.fromEntries(registry.products.map((p) => [p.id, p]));

const POSIX = process.platform !== "win32";
const skip = POSIX ? false : "fixtures use POSIX executables and symlinks";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** Fixture plugin roots carry their dir name as the version when it looks like one (crew's cache rule), else 12.66.0. */
const basenameOf = (dir) => { const b = dir.split(/[\\/]/).pop(); return /^\d+\.\d+\.\d+/.test(b) ? b : "12.66.0"; };

function sandbox(t) {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-first-run-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const bin = join(tmp, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const env = { PATH: bin, HOME: home, USERPROFILE: home };
  const pluginRoot = (dir, version = basenameOf(dir)) => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version }));
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
  assert.deepEqual(findGardenForCrew({ ...sb.env, CODEX_HOME: codexHome }, "linux"), { path: realpathSync(dir), source: "Codex plugin cache", version: "12.66.0" });
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
  assert.deepEqual(findGardenForCrew({ ...sb.env, CLAUDE_CONFIG_DIR: cfg }, "linux"), { path: realpathSync(dir), source: "Claude Code plugin cache", version: "12.66.0" });
  // crew reads ONLY the override when it is set.
  assert.match(findGardenForCrew({ ...sb.env, CLAUDE_CONFIG_DIR: cfg, WICKED_CREW_SKILLS_SOURCE: join(sb.tmp, "nope") }, "linux")?.refused ?? "", /WICKED_CREW_SKILLS_SOURCE=.*fix or unset it/);
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

test("first-run C5: a host whose delivery failed gets no host-scoped readiness row", (t) => {
  const sb = sandbox(t);
  const garden = byId["wicked-garden"];
  const all = preflight([garden], { hosts: ["claude", "codex"], probeOnly: true, platform: "linux", env: sb.env });
  assert.ok(all.some((r) => r.capability === "plugin-scripts"), "control: Claude Code's row exists when Claude Code is a delivered host");
  const rows = preflight([garden], { hosts: ["claude", "codex"], hostsFor: () => ["codex"], probeOnly: true, platform: "linux", env: sb.env });
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
  assert.match(ui, /select none to skip per-agent setup/);
});

test("first-run C8: the PATH fix on macOS writes to ~/.zprofile (zsh never reads ~/.profile)", () => {
  assert.match(pathFix("/x/.local/bin", "darwin"), /~\/\.zprofile/);
  assert.match(pathFix("/x/.local/bin", "linux"), /~\/\.profile/);
});

// --- C5: status before install ------------------------------------------------------------

test("first-run C5: `status` on a clean machine reports no capability of an uninstalled product as ready", { skip }, (t) => {
  const sb = sandbox(t);
  // node, a Python at the floor and a detected Claude Code — but no garden anywhere. Before the
  // fix, garden's Claude-only capability (whose only need is Python) read "ready" here.
  symlinkSync(process.execPath, join(sb.bin, "node"));
  writeFileSync(join(sb.bin, "python3"), "#!/bin/sh\necho 'Python 3.12.1'\n", { mode: 0o755 });
  writeFileSync(join(sb.bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n", { mode: 0o755 });
  const res = spawnSync(process.execPath, [join(root, "dist", "index.js"), "status", "--offline"], {
    env: { ...sb.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = strip(`${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(out, /ready\s+wicked-garden/, out);
  assert.doesNotMatch(out, /ready\s+wicked-crew/, out);
  assert.doesNotMatch(out, /wicked-garden — plugin hooks/, out);
  assert.match(out, /Capabilities not checked \(product not installed\): .*wicked-garden/, out);
  assert.equal(res.status, 1, "status still exits 1 when garden is installed on no host");
});

// --- review r1 folds ----------------------------------------------------------------------

test("findGardenForCrew: manifests crew would reject are not a garden (corrupt, versionless, name != version)", { skip }, (t) => {
  const sb = sandbox(t);
  const cache = join(sb.home, ".claude", "plugins", "cache", "wicked-garden", "wicked-garden");
  const write = (name, text) => { mkdirSync(join(cache, name, ".claude-plugin"), { recursive: true }); writeFileSync(join(cache, name, ".claude-plugin", "plugin.json"), text); };
  write("12.66.0", "{not json");
  write("12.66.1", '{"name":"wicked-garden"}');
  write("12.66.2", '{"version":"12.66.9"}');
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined);
  write("12.66.4", '{"version":"12.66.4"}');
  write("12.9.0", '{"version":"12.9.0"}');
  assert.equal(findGardenForCrew(sb.env, "linux")?.version, "12.66.4", "the highest valid version, as crew picks");
});

test("findGardenForCrew: every CLAUDE_CONFIG_DIR entry, then ~/.claude, as crew walks them", { skip }, (t) => {
  const sb = sandbox(t);
  const a = join(sb.tmp, "cfg-a");
  const b = join(sb.tmp, "cfg-b");
  sb.pluginRoot(join(b, "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  assert.equal(findGardenForCrew({ ...sb.env, CLAUDE_CONFIG_DIR: `${a}:${b}` }, "linux")?.source, "Claude Code plugin cache");
  const dflt = sb.pluginRoot(join(sb.home, ".claude", "plugins", "cache", "wicked-garden", "wicked-garden", "12.65.0"));
  mkdirSync(a, { recursive: true });
  assert.equal(findGardenForCrew({ ...sb.env, CLAUDE_CONFIG_DIR: a }, "linux")?.path, realpathSync(dflt), "~/.claude is walked after a custom config dir");
});

test("findGardenForCrew: a garden launcher only in ~/.local/bin is found (crew appends it to its PATH)", { skip }, (t) => {
  const sb = sandbox(t);
  const pkg = join(sb.tmp, "prefix", "lib", "node_modules", "wicked-garden");
  sb.pluginRoot(pkg);
  writeFileSync(join(pkg, "package.json"), '{"name":"wicked-garden"}');
  writeFileSync(join(pkg, "install.mjs"), "", { mode: 0o755 });
  mkdirSync(join(sb.home, ".local", "bin"), { recursive: true });
  symlinkSync(join(pkg, "install.mjs"), join(sb.home, ".local", "bin", "wicked-garden"));
  assert.equal(findGardenForCrew(sb.env, "linux")?.source, "npm package (wicked-garden on PATH)");
});

test("crew readiness judges uv and estate on crew's PATH: uv only in UV_INSTALL_DIR is pending with a PATH fix; estate in XDG_BIN_HOME is met", { skip }, (t) => {
  const sb = sandbox(t);
  sb.exe(sb.bin, "wicked-crew");
  sb.pluginRoot(join(sb.home, ".codex", "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  const uvDir = join(sb.tmp, "uv-dir");
  sb.exe(uvDir, "uv");
  const xdg = join(sb.tmp, "xdg-bin");
  sb.exe(xdg, "wicked-estate");
  const env = { ...sb.env, UV_INSTALL_DIR: uvDir, XDG_BIN_HOME: xdg };
  const row = preflight([byId["wicked-crew"]], { env, platform: "linux", probeOnly: true }).find((r) => r.capability === "daemon");
  const uv = row.needs.find((n) => n.need === "uv");
  assert.equal(uv.met, false);
  assert.equal(uv.remedy, pathFix(uvDir, "linux"));
  assert.equal(row.needs.find((n) => n.need === "backend wicked-estate").met, true);
});

test("runUvInstaller: Windows runs PowerShell with the script as one argument and no shell; POSIX runs the documented pipe through sh", () => {
  const calls = [];
  const spy = (cmd, args, options) => { calls.push({ cmd, args, shell: options.shell, stdio: options.stdio, env: options.env }); return { status: 0 }; };
  const env = { PATH: "x" };
  assert.deepEqual(runUvInstaller("ignored", "win32", env, spy), { status: 0, error: undefined });
  assert.deepEqual(calls[0], { cmd: "powershell", args: ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"], shell: undefined, stdio: "inherit", env });
  runUvInstaller("curl -LsSf https://astral.sh/uv/install.sh | sh", "linux", env, spy);
  assert.deepEqual(calls[1], { cmd: "curl -LsSf https://astral.sh/uv/install.sh | sh", args: undefined, shell: true, stdio: "inherit", env });
});

test("ensureUv: when astral is told not to edit the profile, the message gives the PATH fix instead of 'open a new terminal'", async (t) => {
  const sb = sandbox(t);
  const local = join(sb.home, ".local", "bin");
  const env = { ...sb.env, UV_NO_MODIFY_PATH: "1" };
  const r = await ensureUv({ needed: true, dryRun: false, offline: false, env, platform: "linux", home: sb.home, run: () => { sb.exe(local, "uv"); return { status: 0 }; } });
  assert.equal(r.action, "installed");
  assert.ok(r.message.includes(pathFix(local, "linux")), r.message);
  assert.doesNotMatch(r.message, /open a new terminal to use it there/);
});

test("directHostsFor: a failed or bare-copy Claude registration is not a Claude Code delivery", () => {
  const ok = directHostsFor([{ productId: "wicked-garden", success: true, skipped: false, registration: "registered" }]);
  assert.deepEqual(ok("wicked-garden"), ["claude"]);
  for (const r of [{ success: false, skipped: false, registration: undefined }, { success: true, skipped: false, registration: "fallback" }, { success: true, skipped: true, registration: "manual" }]) {
    assert.deepEqual(directHostsFor([{ productId: "wicked-garden", ...r }])("wicked-garden"), [], JSON.stringify(r));
  }
  assert.deepEqual(ok("wicked-crew"), ["claude"], "non-plugin products keep the machine-wide check");
});

test("first-run B3: crew + garden installed where crew can't see garden -> the garden npm package is installed globally", { skip }, (t) => {
  const sb = sandbox(t);
  const never = () => assert.fail("must not run");
  assert.equal(ensureGardenForCrew({ productIds: ["wicked-bus"], dryRun: false, env: sb.env, platform: "linux", run: never }).action, "not-needed");
  assert.equal(ensureGardenForCrew({ productIds: ["wicked-crew", "wicked-garden"], dryRun: true, env: sb.env, platform: "linux", run: never }).action, "planned");
  const calls = [];
  const pkg = join(sb.tmp, "prefix", "lib", "node_modules", "wicked-garden");
  const r = ensureGardenForCrew({
    productIds: ["wicked-crew", "wicked-garden"], dryRun: false, env: sb.env, platform: "linux",
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      sb.pluginRoot(pkg, "12.66.1");
      writeFileSync(join(pkg, "package.json"), '{"name":"wicked-garden"}');
      writeFileSync(join(pkg, "install.mjs"), "", { mode: 0o755 });
      symlinkSync(join(pkg, "install.mjs"), join(sb.bin, "wicked-garden"));
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [["npm", "install", "-g", "wicked-garden"]]);
  assert.equal(r.action, "installed", r.message);
  // Already visible: nothing runs.
  assert.equal(ensureGardenForCrew({ productIds: ["wicked-crew", "wicked-garden"], dryRun: false, env: sb.env, platform: "linux", run: never }).action, "present");
  const failed = ensureGardenForCrew({ productIds: ["wicked-crew", "wicked-garden"], dryRun: false, env: { ...sb.env, PATH: join(sb.tmp, "empty") }, platform: "linux", run: () => ({ status: 1 }) });
  assert.equal(failed.action, "failed");
  assert.match(failed.message, /npm install -g wicked-garden/);
});

// --- review r2 folds ----------------------------------------------------------------------

/** A wicked-crew npm package of `version` whose launcher is on the sandbox PATH. */
function fakeCrew(sb, version) {
  const crew = join(sb.tmp, "prefix", "lib", "node_modules", "wicked-crew");
  mkdirSync(join(crew, "dist"), { recursive: true });
  writeFileSync(join(crew, "package.json"), JSON.stringify({ name: "wicked-crew", version }));
  writeFileSync(join(crew, "dist", "cli.js"), "", { mode: 0o755 });
  symlinkSync(join(crew, "dist", "cli.js"), join(sb.bin, "wicked-crew"));
  return crew;
}

test("an older crew (< 0.18.0) is judged by its own rules: no ~/.local/bin on its PATH, no Codex/npm garden", { skip }, (t) => {
  const sb = sandbox(t);
  fakeCrew(sb, "0.17.1");
  const local = join(sb.home, ".local", "bin");
  sb.exe(local, "uv");
  sb.exe(local, "wicked-estate");
  sb.pluginRoot(join(sb.home, ".codex", "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined, "0.17.1 reads only Claude Code's dirs");
  const row = preflight([byId["wicked-crew"]], { env: sb.env, platform: "linux", probeOnly: true }).find((r) => r.capability === "daemon");
  assert.equal(row.state, "pending");
  assert.equal(row.needs.find((n) => n.need === "uv").met, false, "0.17.1 does not add ~/.local/bin to its PATH");
  assert.equal(row.needs.find((n) => n.need === "wicked-garden for crew").remedy, "npm i -g wicked-crew@latest");
  const r = ensureGardenForCrew({ productIds: ["wicked-crew", "wicked-garden"], dryRun: false, env: sb.env, platform: "linux", run: () => assert.fail("an npm garden would not help this crew") });
  assert.equal(r.action, "failed");
  assert.match(r.message, /older than 0\.18\.0/);
});

test("the current crew (>= 0.18.0) on PATH gets the installer locations", { skip }, (t) => {
  const sb = sandbox(t);
  const crew = fakeCrew(sb, "0.18.0");
  sb.pluginRoot(join(dirname(crew), "wicked-garden"));
  assert.equal(findGardenForCrew(sb.env, "linux")?.source, "npm package beside wicked-crew");
});

test("findGardenForCrew: a linked <config>/plugins is not walked; a symlinked manifest anywhere in the cache is a refusal; non-SemVer names are ignored", { skip }, (t) => {
  const sb = sandbox(t);
  const elsewhere = join(sb.tmp, "elsewhere");
  sb.pluginRoot(join(elsewhere, "cache", "wicked-garden", "wicked-garden", "12.66.0"));
  mkdirSync(join(sb.home, ".claude"), { recursive: true });
  symlinkSync(elsewhere, join(sb.home, ".claude", "plugins"));
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined, "crew never follows a link below the config root");

  const sb2 = sandbox(t);
  const cache = join(sb2.home, ".claude", "plugins", "cache", "wicked-garden", "wicked-garden");
  sb2.pluginRoot(join(cache, "12.66.0"));
  mkdirSync(join(cache, "12.65.0", ".claude-plugin"), { recursive: true });
  writeFileSync(join(sb2.tmp, "m.json"), '{"version":"12.65.0"}');
  symlinkSync(join(sb2.tmp, "m.json"), join(cache, "12.65.0", ".claude-plugin", "plugin.json"));
  assert.match(findGardenForCrew(sb2.env, "linux")?.refused ?? "", /symlink/);

  const sb3 = sandbox(t);
  const c3 = join(sb3.home, ".claude", "plugins", "cache", "wicked-garden", "wicked-garden", "012.66.0");
  mkdirSync(join(c3, ".claude-plugin"), { recursive: true });
  writeFileSync(join(c3, ".claude-plugin", "plugin.json"), '{"version":"012.66.0"}');
  assert.equal(findGardenForCrew(sb3.env, "linux"), undefined);
});

test("ensureGardenForCrew never installs the published garden under --source-root, nor to fix a bad override", { skip }, (t) => {
  const sb = sandbox(t);
  const never = () => assert.fail("must not run npm");
  const ids = ["wicked-crew", "wicked-garden"];
  const src = ensureGardenForCrew({ productIds: ids, dryRun: false, sourceRoot: join(sb.tmp, "src"), env: sb.env, platform: "linux", run: never });
  assert.equal(src.action, "failed");
  assert.match(src.message, /--source-root/);
  const bad = ensureGardenForCrew({ productIds: ids, dryRun: false, env: { ...sb.env, WICKED_CREW_SKILLS_SOURCE: join(sb.tmp, "nope") }, platform: "linux", run: never });
  assert.equal(bad.action, "failed");
  assert.match(bad.message, /fix or unset it/);
});

// --- #56: a garden below crew's floor is not "present" -------------------------------------

const IDS = ["wicked-crew", "wicked-garden"];
const readJson = (f) => readFileSync(f, "utf8");

/** An npm garden of `version` whose launcher is on PATH; `install` rewrites its manifest. */
function npmGarden(sb, version, dir = join(sb.tmp, "prefix", "lib", "node_modules", "wicked-garden")) {
  sb.pluginRoot(dir, version);
  writeFileSync(join(dir, "package.json"), '{"name":"wicked-garden"}');
  writeFileSync(join(dir, "install.mjs"), "", { mode: 0o755 });
  symlinkSync(join(dir, "install.mjs"), join(sb.bin, "wicked-garden"));
  return dir;
}
const setVersion = (dir, version) => writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version }));
const ensure = (sb, extra = {}) => ensureGardenForCrew({ productIds: IDS, dryRun: false, env: sb.env, platform: "linux", ...extra });
/** A crew whose dist/skills/plugin-source.js states `floor`. */
function crewWithFloor(sb, floor) {
  const crew = fakeCrew(sb, "0.18.1");
  mkdirSync(join(crew, "dist", "skills"), { recursive: true });
  writeFileSync(join(crew, "dist", "skills", "plugin-source.js"), `export const REQUIRED_GARDEN_VERSION = "${floor}";\n`);
  return crew;
}

test("#56: an npm garden below the floor is upgraded once with npm install -g wicked-garden@latest and re-checked", { skip }, (t) => {
  for (const beside of [false, true]) {
    const sb = sandbox(t);
    let dir;
    if (beside) {
      const crew = fakeCrew(sb, "0.18.1");
      dir = join(dirname(crew), "wicked-garden");
      sb.pluginRoot(dir, "12.66.0");
    } else dir = npmGarden(sb, "12.66.0");
    const calls = [];
    const r = ensure(sb, { run: (cmd, args) => { calls.push([cmd, ...args]); setVersion(dir, "12.67.0"); return { status: 0 }; } });
    assert.deepEqual(calls, [["npm", "install", "-g", "wicked-garden@latest"]]);
    assert.equal(r.action, "installed", r.message);
  }
});

test("#56: a garden at or above the floor is present and spawns nothing; equal and newer", { skip }, (t) => {
  for (const v of ["12.66.1", "12.67.0"]) {
    const sb = sandbox(t);
    npmGarden(sb, v);
    assert.equal(ensure(sb, { run: () => assert.fail("must not run npm") }).action, "present");
  }
});

test("#56: a failed or ineffective upgrade is failed, never present", { skip }, (t) => {
  const sb = sandbox(t);
  npmGarden(sb, "12.66.0");
  const bad = ensure(sb, { run: () => ({ status: 1 }) });
  assert.equal(bad.action, "failed");
  assert.match(bad.message, /12\.66\.0/);
  assert.match(bad.message, /12\.66\.1/);
  assert.match(bad.message, /npm install -g wicked-garden@latest/);
  let n = 0;
  const same = ensure(sb, { run: () => { n += 1; return { status: 0 }; } });
  assert.equal(same.action, "failed", "exit 0 but still 12.66.0");
  assert.equal(n, 1);
  assert.match(same.message, /still finds 12\.66\.0/);
});

test("#56: dry-run plans the upgrade; --source-root never installs the published package over a stale garden", { skip }, (t) => {
  const sb = sandbox(t);
  npmGarden(sb, "12.66.0");
  const never = () => assert.fail("must not run npm");
  const dry = ensure(sb, { dryRun: true, run: never });
  assert.equal(dry.action, "planned");
  assert.match(dry.message, /npm install -g wicked-garden@latest/);
  const src = ensure(sb, { sourceRoot: join(sb.tmp, "src"), run: never });
  assert.equal(src.action, "failed");
  assert.match(src.message, /--source-root/);
});

test("#56: a stale garden is judged even when only crew is selected; an explicit override is exempt", { skip }, (t) => {
  const sb = sandbox(t);
  npmGarden(sb, "12.66.0");
  let n = 0;
  const r = ensureGardenForCrew({ productIds: ["wicked-crew"], dryRun: false, env: sb.env, platform: "linux", run: () => { n += 1; return { status: 1 }; } });
  assert.equal(r.action, "failed");
  assert.equal(n, 1);
  const src = sb.pluginRoot(join(sb.tmp, "mine"), "1.0.0");
  assert.equal(ensure(sb, { env: { ...sb.env, WICKED_CREW_SKILLS_SOURCE: src }, run: () => assert.fail("exempt") }).action, "present");
  assert.equal(ensureGardenForCrew({ productIds: ["wicked-garden"], dryRun: false, env: sb.env, platform: "linux", run: () => assert.fail("no crew") }).action, "not-needed");
});

test("#56: a stale Claude Code registration is left untouched and the update steps are printed", { skip }, (t) => {
  const sb = sandbox(t);
  const cache = join(sb.home, ".claude", "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0");
  sb.pluginRoot(cache, "12.66.0");
  const manifest = join(cache, ".claude-plugin", "plugin.json");
  const before = readJson(manifest);
  const r = ensure(sb, { run: () => assert.fail("a registration is not an npm package") });
  assert.equal(r.action, "failed");
  assert.match(r.message, /CLAUDE_CONFIG_DIR=\S+ claude plugin marketplace update wicked-garden/);
  assert.match(r.message, /claude plugin update wicked-garden@wicked-garden/);
  assert.match(r.message, /--scope/);
  assert.equal(readJson(manifest), before);

  const sb2 = sandbox(t);
  const copy = sb2.pluginRoot(join(sb2.home, ".claude", "plugins", "wicked-garden"), "12.66.0");
  const r2 = ensure(sb2, { run: () => assert.fail("a registration is not an npm package") });
  assert.equal(r2.action, "failed");
  assert.match(r2.message, /older installer copy/);
  assert.match(r2.message, /claude plugin update wicked-garden@wicked-garden/);
  assert.equal(readJson(join(copy, ".claude-plugin", "plugin.json")), JSON.stringify({ name: "wicked-garden", version: "12.66.0" }));
});

test("#56: the Claude steps quote a config dir with a space, and render cmd.exe syntax on Windows", { skip }, (t) => {
  const sb = sandbox(t);
  const cfg = join(sb.tmp, "my config");
  sb.pluginRoot(join(cfg, "plugins", "cache", "wicked-garden", "wicked-garden", "12.66.0"), "12.66.0");
  const env = { ...sb.env, CLAUDE_CONFIG_DIR: cfg };
  const posix = ensure(sb, { env, run: () => assert.fail("a registration is not an npm package") });
  assert.equal(posix.action, "failed");
  const quoted = realpathSync(cfg);
  assert.ok(posix.message.includes(`CLAUDE_CONFIG_DIR='${quoted}' claude plugin marketplace update wicked-garden`), posix.message);
  assert.ok(posix.message.includes(`CLAUDE_CONFIG_DIR='${quoted}' claude plugin update wicked-garden@wicked-garden`), posix.message);
  // Windows rendering of the same fixture (shape only; discovery runs on this host's paths).
  const win = ensureGardenForCrew({ productIds: IDS, dryRun: false, env, platform: "win32", run: () => assert.fail("no npm") });
  assert.equal(win.action, "failed");
  assert.match(win.message, /set "CLAUDE_CONFIG_DIR=[^"]*my config" && claude plugin update wicked-garden@wicked-garden/);
  assert.doesNotMatch(win.message, /CLAUDE_CONFIG_DIR='/);
});

test("#56: a stale Codex cache entry is left untouched; the steps name its own marketplace", { skip }, (t) => {
  const sb = sandbox(t);
  const dir = join(sb.home, ".codex", "plugins", "cache", "my-market", "wicked-garden", "12.66.0");
  sb.pluginRoot(dir, "12.66.0");
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  const before = readJson(manifest);
  const r = ensure(sb, { run: () => assert.fail("a registration is not an npm package") });
  assert.equal(r.action, "failed");
  assert.match(r.message, /codex plugin add wicked-garden@my-market --json/);
  assert.doesNotMatch(r.message, /codex plugin update/);
  assert.equal(readJson(manifest), before);
});

test("#56: the floor comes from the installed crew when present, else the pinned 12.66.1", { skip }, (t) => {
  // installed crew demands 12.68.0: 12.67.0 is below it
  const sb = sandbox(t);
  crewWithFloor(sb, "12.68.0");
  const dir = npmGarden(sb, "12.67.0");
  const calls = [];
  const r = ensure(sb, { run: (cmd, args) => { calls.push(args); setVersion(dir, "12.68.0"); return { status: 0 }; } });
  assert.equal(calls.length, 1, "12.67.0 passes the pinned floor but not crew's");
  assert.equal(r.action, "installed", r.message);
  assert.equal(crewGardenFloor(sb.env, "linux").from, "crew");
  // no crew: pinned 12.66.1
  const sb2 = sandbox(t);
  assert.deepEqual(crewGardenFloor(sb2.env, "linux"), { version: "12.66.1", from: "fallback" });
  npmGarden(sb2, "12.66.0");
  assert.equal(ensure(sb2, { run: () => ({ status: 1 }) }).action, "failed");
  // a crew whose plugin-source.js is unreadable also falls back
  const sb3 = sandbox(t);
  fakeCrew(sb3, "0.18.1");
  assert.equal(crewGardenFloor(sb3.env, "linux").from, "fallback");
});

// --- review r3 folds ----------------------------------------------------------------------

test("older crew: estate only in ~/.local/bin is not on its PATH, so crew is pending even with uv and garden met", { skip }, (t) => {
  const sb = sandbox(t);
  fakeCrew(sb, "0.17.1");
  sb.exe(sb.bin, "uv");
  sb.pluginRoot(join(sb.home, ".claude", "plugins", "wicked-garden"));
  sb.exe(join(sb.home, ".local", "bin"), "wicked-estate");
  const row = preflight([byId["wicked-crew"]], { env: sb.env, platform: "linux", probeOnly: true }).find((r) => r.capability === "daemon");
  assert.deepEqual(row.needs.filter((n) => !n.met).map((n) => n.need), ["backend wicked-estate"]);
  assert.equal(row.state, "pending");
});

test("findGardenForCrew: Codex — linked plugins/ is not walked; a linked npm manifest or one in any marketplace is a refusal", { skip }, (t) => {
  const sb = sandbox(t);
  const elsewhere = join(sb.tmp, "elsewhere");
  sb.pluginRoot(join(elsewhere, "cache", "m", "wicked-garden", "12.66.0"));
  mkdirSync(join(sb.home, ".codex"), { recursive: true });
  symlinkSync(elsewhere, join(sb.home, ".codex", "plugins"));
  assert.equal(findGardenForCrew(sb.env, "linux"), undefined);

  const sb2 = sandbox(t);
  const cache = join(sb2.home, ".codex", "plugins", "cache");
  sb2.pluginRoot(join(cache, "a", "wicked-garden", "12.66.0"));
  mkdirSync(join(cache, "b", "wicked-garden", "12.65.0", ".claude-plugin"), { recursive: true });
  writeFileSync(join(sb2.tmp, "m.json"), '{"version":"12.65.0"}');
  symlinkSync(join(sb2.tmp, "m.json"), join(cache, "b", "wicked-garden", "12.65.0", ".claude-plugin", "plugin.json"));
  assert.match(findGardenForCrew(sb2.env, "linux")?.refused ?? "", /symlink/);

  const sb3 = sandbox(t);
  const pkg = join(sb3.tmp, "prefix", "lib", "node_modules", "wicked-garden");
  mkdirSync(join(pkg, ".claude-plugin"), { recursive: true });
  writeFileSync(join(sb3.tmp, "m.json"), '{"version":"12.66.0"}');
  symlinkSync(join(sb3.tmp, "m.json"), join(pkg, ".claude-plugin", "plugin.json"));
  writeFileSync(join(pkg, "package.json"), '{"name":"wicked-garden"}');
  writeFileSync(join(pkg, "install.mjs"), "", { mode: 0o755 });
  symlinkSync(join(pkg, "install.mjs"), join(sb3.bin, "wicked-garden"));
  sb3.pluginRoot(join(sb3.home, ".codex", "plugins", "cache", "m", "wicked-garden", "12.66.0"));
  assert.match(findGardenForCrew(sb3.env, "linux")?.refused ?? "", /symlink/, "no silent fallback past a linked npm manifest");
});

test("an explicit override whose manifest version is the string 'link' is still a garden (crew accepts any non-empty version there)", { skip }, (t) => {
  const sb = sandbox(t);
  const dir = join(sb.tmp, "override");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"version":"link"}');
  assert.equal(findGardenForCrew({ ...sb.env, WICKED_CREW_SKILLS_SOURCE: dir }, "linux")?.version, "link");
});
