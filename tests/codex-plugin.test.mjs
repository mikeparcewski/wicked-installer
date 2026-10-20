import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * install-codex on a codex with `codex plugin` (0.163+): wicked-garden is registered as a plugin
 * through a local marketplace, the loose skills the installer copied before are removed (only
 * those it can attribute to itself), and the wicked-estate MCP entry is repaired. A spawn-recording
 * codex stub (tests/codex-stub.mjs) stands in for the CLI; HOME is a sandbox, so ~/.cargo/bin and
 * ~/.local/bin are the sandbox's.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "dist", "install-codex.js");
const stubSrc = join(root, "tests", "codex-stub.mjs");
const skip = process.platform === "win32" ? "POSIX shebang stubs" : false;

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function skill(dir, name, desc = "d") {
  write(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
}

function garden(dir, version = "1.0.0", skills = ["alpha", "alpha/beta", "gamma"]) {
  write(join(dir, "package.json"), JSON.stringify({ name: "wicked-garden", version }));
  write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version }));
  write(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "wicked-garden", plugins: [{ name: "wicked-garden", source: "./", version }] }));
  write(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "wicked-garden", version, skills: "./skills", mcpServers: "./.codex-plugin/mcp.json", hooks: { hooks: {} } }));
  write(join(dir, ".codex-plugin", "mcp.json"), JSON.stringify({ mcpServers: { "wicked-estate": { command: "wicked-garden", args: ["run", "scripts/estate_mcp.mjs"] } } }));
  rmSync(join(dir, "skills"), { recursive: true, force: true });
  for (const s of skills) skill(join(dir, "skills", s), `wicked-garden-${s.replace("/", "-")}`);
}

function fakeEstate(dir, version) {
  write(join(dir, "wicked-estate-mcp"), "#!/bin/sh\nexit 0\n");
  write(join(dir, "wicked-estate"), `#!/bin/sh\necho "wicked-estate ${version}"\n`);
  chmodSync(join(dir, "wicked-estate-mcp"), 0o755);
  chmodSync(join(dir, "wicked-estate"), 0o755);
}

function sandbox({ withManifest = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "wi-codex-plugin-"));
  const sb = {
    tmp,
    home: join(tmp, "home"),
    bin: join(tmp, "bin"),
    src: join(tmp, "src"),
    codexHome: join(tmp, "home", ".codex-test"),
    log: join(tmp, "codex.log"),
    registry: join(tmp, "registry.json"),
  };
  mkdirSync(sb.home, { recursive: true });
  mkdirSync(sb.bin, { recursive: true });
  cpSync(stubSrc, join(sb.bin, "codex"));
  chmodSync(join(sb.bin, "codex"), 0o755);
  // npm stub: `root -g` answers the sandbox's global root; installs are recorded, never run.
  write(join(sb.bin, "npm"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(tmp, "npm.log"))}\nif [ "$1" = root ]; then echo ${JSON.stringify(join(tmp, "global"))}; fi\nexit 0\n`);
  chmodSync(join(sb.bin, "npm"), 0o755);
  // Launcher on PATH so readiness has nothing pending.
  write(join(sb.bin, "wicked-garden"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(sb.bin, "wicked-garden"), 0o755);
  garden(join(sb.src, "wicked-garden"));
  if (!withManifest) rmSync(join(sb.src, "wicked-garden", ".codex-plugin"), { recursive: true });
  write(sb.registry, JSON.stringify({
    version: "1",
    products: [{
      id: "wicked-garden", displayName: "Wicked Garden", description: "d", type: "claude-plugin", standalone: false,
      opinionated: true, status: "active", requires: [], install: { type: "npm-run", package: "wicked-garden", command: "install", codexPlugin: true },
    }, {
      id: "wicked-estate", displayName: "Wicked Estate", description: "d", type: "mcp-binary", standalone: true,
      opinionated: false, status: "stable", requires: [], install: { type: "cargo", crates: ["wicked-estate", "wicked-estate-mcp"], crate: "wicked-estate-mcp" },
    }],
  }));
  return sb;
}

function run(sb, args = [], env = {}) {
  const res = spawnSync(process.execPath, [script, "wicked-garden", "--codex-home", sb.codexHome, "--registry", sb.registry, "--source-root", sb.src, "--skip-binaries", "--json", ...args], {
    encoding: "utf8",
    env: { PATH: `${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, CODEX_STUB_LOG: sb.log, ...env },
    timeout: 60000,
  });
  const tail = res.stdout.slice(res.stdout.lastIndexOf('\n{\n  "codexHome"') + 1);
  let report;
  try {
    report = JSON.parse(tail);
  } catch {
    report = undefined;
  }
  return { ...res, report, garden: report?.reports?.find((r) => r.productId === "wicked-garden") };
}

const calls = (sb) => (existsSync(sb.log) ? readFileSync(sb.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const marker = (sb) => JSON.parse(readFileSync(join(sb.codexHome, "wicked-installer", "codex-install.json"), "utf8"));
const state = (sb) => JSON.parse(readFileSync(join(sb.codexHome, "stub-state.json"), "utf8"));
const cleanup = (sb) => rmSync(sb.tmp, { recursive: true, force: true });

test("plugin path: garden is registered through a local marketplace, every codex call pinned to the target home", { skip }, () => {
  const sb = sandbox();
  try {
    const r = run(sb, [], { CODEX_HOME: join(sb.tmp, "elsewhere") });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.garden.success, true);
    assert.equal(r.garden.delivery, "registered");
    assert.equal(r.garden.assets.skills, 3, "nested SKILL.md files count, as Codex discovers them");
    const st = state(sb);
    assert.equal(st.marketplaces["wicked-garden"].source, join(sb.src, "wicked-garden"));
    assert.equal(st.plugins["wicked-garden@wicked-garden"].version, "1.0.0");
    assert.ok(calls(sb).every((c) => c.home === sb.codexHome), "every codex call carried CODEX_HOME = --codex-home");
    assert.deepEqual(marker(sb).products.find((p) => p.id === "wicked-garden").codexPlugin, {
      pluginId: "wicked-garden@wicked-garden", marketplace: "wicked-garden", source: join(sb.src, "wicked-garden"), version: "1.0.0", addedByInstaller: true,
    });
    assert.ok(!existsSync(join(sb.codexHome, "skills", "wicked-garden-alpha")), "no loose copies on the plugin path");
  } finally {
    cleanup(sb);
  }
});

test("plugin path is idempotent: a re-run adds nothing and says so", { skip }, () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb).status, 0);
    const before = calls(sb).length;
    const r = run(sb);
    assert.equal(r.status, 0);
    const second = calls(sb).slice(before).map((c) => c.argv.slice(0, 3).join(" "));
    assert.ok(!second.some((c) => c.startsWith("plugin marketplace add") || c.startsWith("plugin add") || c.startsWith("mcp add")), second.join("; "));
    assert.ok(r.garden.notes.some((n) => /marketplace wicked-garden already/.test(n)));
    assert.ok(r.garden.notes.some((n) => /already installed/.test(n)));
  } finally {
    cleanup(sb);
  }
});

test("a new garden version re-adds the plugin", { skip }, () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb).status, 0);
    garden(join(sb.src, "wicked-garden"), "1.1.0");
    const r = run(sb);
    assert.equal(r.status, 0);
    assert.ok(r.garden.notes.some((n) => n === "updated plugin wicked-garden@wicked-garden 1.0.0 -> 1.1.0"), r.garden.notes.join("\n"));
    assert.equal(state(sb).plugins["wicked-garden@wicked-garden"].version, "1.1.0");
  } finally {
    cleanup(sb);
  }
});

test("a pre-1.1 (count-only) marker proves no directory: nothing is removed without --prune-legacy-skills", { skip }, () => {
  const sb = sandbox();
  try {
    const skills = join(sb.codexHome, "skills");
    skill(join(skills, "wicked-garden-old"), "wicked-garden-old");
    skill(join(skills, "wicked-garden-user-private"), "wicked-garden-user-private");
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({
      products: [{ id: "wicked-garden", success: true, skipped: false, assets: { skills: 1 }, notes: [] }],
    }));
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(skills).sort(), ["wicked-garden-old", "wicked-garden-user-private"]);
    assert.ok(r.garden.notes.some((n) => /2 loose wicked-garden-\* skill dir\(s\).*lists wicked-garden but not which dirs.*--prune-legacy-skills/.test(n)), r.garden.notes.join("\n"));
    const dry = run(sb, ["--dry-run"]);
    assert.ok(dry.garden.notes.some((n) => /wicked-garden-old, wicked-garden-user-private/.test(n)), "a dry run names them");
  } finally {
    cleanup(sb);
  }
});

test("--prune-legacy-skills removes the installer-named loose skills, leaves everything else", { skip }, () => {
  const sb = sandbox();
  try {
    const skills = join(sb.codexHome, "skills");
    for (const n of ["wicked-garden-crew-implementer", "wicked-garden-smaht", "wicked-garden-alpha"]) skill(join(skills, n), n);
    skill(join(skills, "my-own"), "my-own");
    skill(join(skills, "wicked-garden-mine"), "my-mine"); // installer-like dir, but not the installer's naming
    skill(join(sb.tmp, "ext"), "wicked-garden-linked");
    symlinkSync(join(sb.tmp, "ext"), join(skills, "wicked-garden-linked"));
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({
      installedAt: "x", codexHome: sb.codexHome, products: [{ id: "wicked-garden", success: true, skipped: false, assets: { skills: 3 }, notes: [] }],
    }));
    const r = run(sb, ["--prune-legacy-skills"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(skills).sort(), ["my-own", "wicked-garden-linked", "wicked-garden-mine"]);
    assert.ok(lstatSync(join(skills, "wicked-garden-linked")).isSymbolicLink(), "the symlink is untouched");
    const backups = readdirSync(join(sb.codexHome, "wicked-installer", "pruned-skills"));
    assert.equal(backups.length, 1);
    assert.deepEqual(readdirSync(join(sb.codexHome, "wicked-installer", "pruned-skills", backups[0])).sort(),
      ["wicked-garden-alpha", "wicked-garden-crew-implementer", "wicked-garden-smaht"]);
    assert.ok(r.garden.notes.some((n) => /removed 3 loose wicked-garden skill\(s\)/.test(n)));
    assert.deepEqual(marker(sb).products.find((p) => p.id === "wicked-garden").skills, [], "nothing loose is owned any more");
    // Idempotent: nothing left to prune, and the user's symlink is not offered for --prune-legacy-skills.
    const again = run(sb, ["--prune-legacy-skills"]);
    assert.ok(!again.garden.notes.some((n) => /removed|not recorded/.test(n)), again.garden.notes.join("\n"));
  } finally {
    cleanup(sb);
  }
});

test("a v1.1 marker's recorded skill list is exactly what gets pruned", { skip }, () => {
  const sb = sandbox();
  try {
    const skills = join(sb.codexHome, "skills");
    skill(join(skills, "wicked-garden-old"), "wicked-garden-old");
    skill(join(skills, "wicked-garden-unrecorded"), "wicked-garden-unrecorded");
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({
      products: [{ id: "wicked-garden", success: true, assets: { skills: 1 }, skills: ["wicked-garden-old", "../escape"] }],
    }));
    mkdirSync(join(sb.codexHome, "escape"), { recursive: true });
    const r = run(sb);
    assert.equal(r.status, 0);
    assert.deepEqual(readdirSync(skills), ["wicked-garden-unrecorded"]);
    assert.ok(existsSync(join(sb.codexHome, "escape")), "a recorded name is never a path");
  } finally {
    cleanup(sb);
  }
});

test("an empty or odd recorded name never moves the skills directory itself", { skip }, () => {
  const sb = sandbox();
  try {
    const skills = join(sb.codexHome, "skills");
    skill(join(skills, "my-own"), "my-own");
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({ products: [{ id: "wicked-garden", success: true, assets: { skills: 1 }, skills: ["", ".", "..", "/", "a/../.."] }] }));
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(skills), ["my-own"]);
    assert.ok(!existsSync(join(sb.codexHome, "wicked-installer", "pruned-skills")), "nothing was moved");
  } finally {
    cleanup(sb);
  }
});

test("without a marker record, installer-named skills are left (and named); --prune-legacy-skills removes them", { skip }, () => {
  const sb = sandbox();
  try {
    const skills = join(sb.codexHome, "skills");
    skill(join(skills, "wicked-garden-old"), "wicked-garden-old");
    const r = run(sb);
    assert.ok(existsSync(join(skills, "wicked-garden-old")));
    assert.ok(r.garden.notes.some((n) => /1 loose wicked-garden-\* skill dir\(s\).*--prune-legacy-skills/.test(n)), r.garden.notes.join("\n"));
    run(sb, ["--prune-legacy-skills"]);
    assert.ok(!existsSync(join(skills, "wicked-garden-old")));
  } finally {
    cleanup(sb);
  }
});

test("an unreadable marker prunes nothing and is kept aside, not overwritten", { skip }, () => {
  const sb = sandbox();
  try {
    skill(join(sb.codexHome, "skills", "wicked-garden-old"), "wicked-garden-old");
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), "{not json");
    const r = run(sb, ["--prune-legacy-skills"]);
    assert.ok(existsSync(join(sb.codexHome, "skills", "wicked-garden-old")));
    assert.ok(r.garden.notes.some((n) => /unreadable/.test(n)));
    const kept = readdirSync(join(sb.codexHome, "wicked-installer")).filter((n) => n.startsWith("codex-install.json.unreadable-"));
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(join(sb.codexHome, "wicked-installer", kept[0]), "utf8"), "{not json");
    assert.equal(marker(sb).products.find((p) => p.id === "wicked-garden").skills, undefined, "no ownership list is invented");
  } finally {
    cleanup(sb);
  }
});

test("a failed plugin add rolls back the marketplace it added this run", { skip }, () => {
  const sb = sandbox();
  try {
    const r = run(sb, [], { CODEX_STUB_FAIL: "plugin-add" });
    assert.equal(r.garden.success, false);
    assert.match(r.garden.message, /the marketplace it added was removed again/);
    assert.deepEqual(state(sb).marketplaces, {});
    // A clean retry then owns what it adds.
    assert.equal(run(sb).garden.success, true);
    assert.equal(marker(sb).products.find((p) => p.id === "wicked-garden").codexPlugin.addedByInstaller, true);
  } finally {
    cleanup(sb);
  }
});

test("a failed plugin add removes nothing and keeps the earlier ownership record", { skip }, () => {
  const sb = sandbox();
  try {
    skill(join(sb.codexHome, "skills", "wicked-garden-old"), "wicked-garden-old");
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({ products: [{ id: "wicked-garden", success: true, assets: { skills: 1 }, skills: ["wicked-garden-old"] }] }));
    const r = run(sb, [], { CODEX_STUB_FAIL: "plugin-add" });
    assert.equal(r.status, 1);
    assert.equal(r.garden.success, false);
    assert.ok(existsSync(join(sb.codexHome, "skills", "wicked-garden-old")));
    assert.deepEqual(marker(sb).products.find((p) => p.id === "wicked-garden").skills, ["wicked-garden-old"]);
  } finally {
    cleanup(sb);
  }
});

test("a failed run keeps a count-only marker entry whole (its evidence is not erased)", { skip }, () => {
  const sb = sandbox();
  try {
    const legacy = { id: "wicked-garden", success: true, skipped: false, assets: { skills: 3 }, notes: ["x"] };
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({ products: [legacy] }));
    const r = run(sb, [], { CODEX_STUB_FAIL: "plugin-add" });
    assert.equal(r.status, 1);
    const entry = marker(sb).products.find((p) => p.id === "wicked-garden");
    assert.equal(entry.success, true);
    assert.deepEqual(entry.assets, { skills: 3 });
    assert.match(entry.lastFailure.message, /codex plugin add .* failed/);
  } finally {
    cleanup(sb);
  }
});

test("codex without `codex plugin`: skills are copied, recorded by name, and a dropped skill is pruned next run", { skip }, () => {
  const sb = sandbox();
  try {
    const r = run(sb, [], { CODEX_STUB_NO_PLUGIN: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.garden.delivery, "copied");
    const skills = join(sb.codexHome, "skills");
    assert.deepEqual(readdirSync(skills).sort(), ["wicked-garden-alpha", "wicked-garden-gamma"]);
    assert.deepEqual(marker(sb).products.find((p) => p.id === "wicked-garden").skills.sort(), ["wicked-garden-alpha", "wicked-garden-gamma"]);
    garden(join(sb.src, "wicked-garden"), "1.0.1", ["alpha"]);
    run(sb, [], { CODEX_STUB_NO_PLUGIN: "1" });
    assert.deepEqual(readdirSync(skills), ["wicked-garden-alpha"]);
  } finally {
    cleanup(sb);
  }
});

test("a garden without .codex-plugin falls back to the copy path even on a plugin-capable codex", { skip }, () => {
  const sb = sandbox({ withManifest: false });
  try {
    const r = run(sb);
    assert.equal(r.garden.delivery, "copied");
    assert.ok(r.garden.notes.some((n) => /no \.codex-plugin\/plugin\.json/.test(n)));
    assert.ok(!calls(sb).some((c) => c.argv[0] === "plugin" && c.argv[1] === "add"));
  } finally {
    cleanup(sb);
  }
});

test("the global npm package is the plugin source when there is no local checkout", { skip }, () => {
  const sb = sandbox();
  try {
    rmSync(join(sb.src, "wicked-garden"), { recursive: true });
    garden(join(sb.tmp, "global", "wicked-garden"), "2.0.0");
    const r = run(sb);
    assert.equal(r.garden.delivery, "registered");
    assert.equal(state(sb).marketplaces["wicked-garden"].source, join(sb.tmp, "global", "wicked-garden"));
    assert.ok(!existsSync(join(sb.tmp, "npm.log")) || !/install/.test(readFileSync(join(sb.tmp, "npm.log"), "utf8")), "--skip-binaries installs nothing");
  } finally {
    cleanup(sb);
  }
});

test("an npm-run product the registry does not mark as a Codex plugin is never installed globally for it", { skip }, () => {
  const sb = sandbox();
  try {
    rmSync(join(sb.src, "wicked-garden"), { recursive: true });
    const reg = JSON.parse(readFileSync(sb.registry, "utf8"));
    delete reg.products[0].install.codexPlugin;
    writeFileSync(sb.registry, JSON.stringify(reg));
    garden(join(sb.tmp, "global", "wicked-garden"), "2.0.0");
    const res = spawnSync(process.execPath, [script, "wicked-garden", "--codex-home", sb.codexHome, "--registry", sb.registry, "--source-root", sb.src, "--json"], {
      encoding: "utf8", env: { PATH: `${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, CODEX_STUB_LOG: sb.log }, timeout: 60000,
    });
    // (The copy path then tries `npm pack`, which this npm stub does not emulate — the exit code is not the point.)
    const npmLog = existsSync(join(sb.tmp, "npm.log")) ? readFileSync(join(sb.tmp, "npm.log"), "utf8") : "";
    assert.doesNotMatch(npmLog, /install -g wicked-garden/);
    assert.ok(!calls(sb).some((c) => c.argv[0] === "plugin" && c.argv[1] === "add"));
  } finally {
    cleanup(sb);
  }
});

test("without --skip-binaries the marked package is installed globally first", { skip }, () => {
  const sb = sandbox();
  try {
    rmSync(join(sb.src, "wicked-garden"), { recursive: true });
    garden(join(sb.tmp, "global", "wicked-garden"), "2.0.0");
    const res = spawnSync(process.execPath, [script, "wicked-garden", "--codex-home", sb.codexHome, "--registry", sb.registry, "--source-root", sb.src, "--json"], {
      encoding: "utf8", env: { PATH: `${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, CODEX_STUB_LOG: sb.log }, timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(join(sb.tmp, "npm.log"), "utf8"), /^install -g wicked-garden$/m);
    assert.equal(state(sb).plugins["wicked-garden@wicked-garden"].version, "2.0.0");
  } finally {
    cleanup(sb);
  }
});

test("a marketplace already at the same root but added by hand is not claimed", { skip }, () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.codexHome, { recursive: true });
    write(join(sb.codexHome, "stub-state.json"), JSON.stringify({ marketplaces: { "wicked-garden": { source: join(sb.src, "wicked-garden") } }, plugins: {}, mcp: {} }));
    const r = run(sb);
    assert.ok(r.garden.notes.some((n) => /added outside wicked-installer/.test(n)));
    assert.equal(marker(sb).products.find((p) => p.id === "wicked-garden").codexPlugin.addedByInstaller, false);
    // A later run from another root must not repoint it without --force.
    rmSync(join(sb.src, "wicked-garden"), { recursive: true });
    garden(join(sb.tmp, "global", "wicked-garden"), "1.0.0");
    run(sb);
    assert.equal(state(sb).marketplaces["wicked-garden"].source, join(sb.src, "wicked-garden"));
  } finally {
    cleanup(sb);
  }
});

test("repointing the installer's own marketplace re-copies the plugin even at the same version", { skip }, () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb).status, 0);
    const before = calls(sb).length;
    rmSync(join(sb.src, "wicked-garden"), { recursive: true });
    garden(join(sb.tmp, "global", "wicked-garden"), "1.0.0");
    const r = run(sb);
    assert.ok(r.garden.notes.some((n) => /repointed marketplace wicked-garden/.test(n)), r.garden.notes.join("\n"));
    assert.ok(calls(sb).slice(before).some((c) => c.argv[0] === "plugin" && c.argv[1] === "add"), "plugin re-added from the new root");
    assert.ok(state(sb).plugins["wicked-garden@wicked-garden"].path.length > 0);
  } finally {
    cleanup(sb);
  }
});

test("a non-local (git) marketplace is never repointed, even with --force", { skip }, () => {
  const sb = sandbox();
  try {
    const clone = join(sb.tmp, "git-clone");
    garden(clone, "0.9.0");
    mkdirSync(sb.codexHome, { recursive: true });
    write(join(sb.codexHome, "stub-state.json"), JSON.stringify({ marketplaces: { "wicked-garden": { source: clone, sourceType: "git" } }, plugins: {}, mcp: {} }));
    const r = run(sb, ["--force"]);
    assert.equal(state(sb).marketplaces["wicked-garden"].source, clone);
    assert.ok(r.garden.notes.some((n) => /a git source\) — installing from it; to use .* run `codex plugin marketplace remove wicked-garden` first/.test(n)), r.garden.notes.join("\n"));
    assert.ok(!calls(sb).some((c) => c.argv.slice(0, 3).join(" ") === "plugin marketplace remove"));
  } finally {
    cleanup(sb);
  }
});

test("a marketplace another source configured is used, not repointed, unless --force", { skip }, () => {
  const sb = sandbox();
  try {
    const other = join(sb.tmp, "other-garden");
    garden(other, "0.9.0");
    mkdirSync(sb.codexHome, { recursive: true });
    write(join(sb.codexHome, "stub-state.json"), JSON.stringify({ marketplaces: { "wicked-garden": { source: other } }, plugins: {}, mcp: {} }));
    const r = run(sb);
    assert.equal(state(sb).marketplaces["wicked-garden"].source, other);
    assert.ok(r.garden.notes.some((n) => /not by wicked-installer/.test(n)));
    assert.equal(state(sb).plugins["wicked-garden@wicked-garden"].version, "0.9.0");
    run(sb);
    assert.equal(state(sb).marketplaces["wicked-garden"].source, other, "a re-run still does not claim it");
    run(sb, ["--force"]);
    assert.equal(state(sb).marketplaces["wicked-garden"].source, join(sb.src, "wicked-garden"));
    assert.equal(state(sb).plugins["wicked-garden@wicked-garden"].version, "1.0.0");
  } finally {
    cleanup(sb);
  }
});

const configToml = (sb) => (existsSync(join(sb.codexHome, "config.toml")) ? readFileSync(join(sb.codexHome, "config.toml"), "utf8") : "");
const seedConfig = (sb, toml) => write(join(sb.codexHome, "config.toml"), toml);

test("estate: a stale config entry gets only its command line replaced (every other setting kept); a stale ~/.cargo/bin copy on PATH is called out", { skip }, () => {
  const sb = sandbox();
  try {
    const cargo = join(sb.home, ".cargo", "bin");
    const local = join(sb.home, ".local", "bin");
    fakeEstate(cargo, "0.29.2");
    fakeEstate(local, "0.30.0");
    const before = [
      "[mcp_servers.wicked-estate]",
      'command = "/opt/old/wicked-estate-mcp" # stale',
      'args = ["--readonly"]',
      'cwd = "/work"',
      'env_vars = ["TOKEN"]',
      "enabled = false",
      "required = true",
      'default_tools_approval_mode = "prompt"',
      'enabled_tools = ["Recall"]',
      "",
      "[mcp_servers.wicked-estate.env]",
      'WICKED_ESTATE_DB = "/db"',
      "",
    ].join("\n");
    seedConfig(sb, before);
    const res = spawnSync(process.execPath, [script, "wicked-garden", "--codex-home", sb.codexHome, "--registry", sb.registry, "--source-root", sb.src, "--skip-binaries", "--json"], {
      encoding: "utf8", env: { PATH: `${cargo}:${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, CODEX_STUB_LOG: sb.log }, timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(configToml(sb), before.replace('"/opt/old/wicked-estate-mcp"', JSON.stringify(join(local, "wicked-estate-mcp"))));
    assert.match(res.stdout, /only its command line changed/);
    assert.match(res.stdout, /stale ~\/\.cargo\/bin\/wicked-estate-mcp \(0\.29\.2\) shadows ~\/\.local\/bin\/wicked-estate-mcp \(0\.30\.0\) on PATH/);
    assert.ok(!calls(sb).some((c) => c.argv[0] === "mcp" && (c.argv[1] === "add" || c.argv[1] === "remove")), "no lossy add/remove on an existing entry");
    assert.ok(!readdirSync(sb.codexHome).some((n) => n.includes("wicked-bak") || n.includes("wicked-tmp")), "backup removed after the read-back");
  } finally {
    cleanup(sb);
  }
});

test("estate: a user entry shaped like the plugin's (`wicked-garden run …`) is still a config entry — edited, not replaced", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".cargo", "bin"), "0.30.0"); // off PATH: the launcher cannot find it
    const before = '[mcp_servers.wicked-estate]\ncommand = "wicked-garden"\nargs = ["run", "scripts/estate_mcp.mjs"]\ncwd = "/work"\nenabled = false\n';
    seedConfig(sb, before);
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(configToml(sb).split("\n[marketplaces")[0].trimEnd(), before.replace('"wicked-garden"', JSON.stringify(join(sb.home, ".cargo", "bin", "wicked-estate-mcp"))).trimEnd());
  } finally {
    cleanup(sb);
  }
});

test("estate: an entry in a form other than one [mcp_servers.<name>] table is not touched", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".local", "bin"), "0.30.0");
    const before = '[mcp_servers]\nwicked-estate = { command = "/opt/old/wicked-estate-mcp" }\n';
    seedConfig(sb, before);
    const r = run(sb);
    assert.ok(configToml(sb).startsWith(before));
    assert.ok(r.garden.notes.some((n) => /not changed \(wicked-estate is defined in a form other than/.test(n)), r.garden.notes.join("\n"));
  } finally {
    cleanup(sb);
  }
});

test("estate: a quoted-key table header is edited like a bare one; CRLF and the file mode are kept", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".local", "bin"), "0.30.0");
    const before = '["mcp_servers"."wicked-estate"] # mine\r\ncommand = "/opt/old/wicked-estate-mcp" # stale\r\nrequired = true\r\n';
    seedConfig(sb, before);
    chmodSync(join(sb.codexHome, "config.toml"), 0o600);
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(configToml(sb).startsWith(before.replace('"/opt/old/wicked-estate-mcp"', JSON.stringify(join(sb.home, ".local", "bin", "wicked-estate-mcp")))), configToml(sb));
    assert.equal(statSync(join(sb.codexHome, "config.toml")).mode & 0o777, 0o600);
  } finally {
    cleanup(sb);
  }
});

for (const [label, toml] of [
  ["dotted keys at the root", 'mcp_servers."wicked-estate".command = "wicked-garden"\nmcp_servers."wicked-estate".args = ["run", "scripts/estate_mcp.mjs"]\nmcp_servers."wicked-estate".enabled = false\n'],
  ["a key under [mcp_servers]", '[mcp_servers]\n"wicked-estate" = { command = "wicked-garden", args = ["run", "scripts/estate_mcp.mjs"], enabled = false }\n'],
  ["a repeated table", '[mcp_servers.wicked-estate]\ncommand = "a"\n[mcp_servers."wicked-estate"]\ncommand = "b"\n'],
]) {
  test(`estate: an entry written as ${label} is never treated as absent (no \`codex mcp add\` over it)`, { skip }, () => {
    const sb = sandbox();
    try {
      fakeEstate(join(sb.home, ".cargo", "bin"), "0.30.0"); // off PATH: an absent entry WOULD be added
      seedConfig(sb, toml);
      const r = run(sb);
      assert.ok(configToml(sb).startsWith(toml), configToml(sb));
      assert.ok(!calls(sb).some((c) => c.argv[0] === "mcp" && c.argv[1] === "add"), "no mcp add");
      assert.ok(r.garden.notes.some((n) => /Codex MCP server wicked-estate: not changed/.test(n)), r.garden.notes.join("\n"));
    } finally {
      cleanup(sb);
    }
  });
}

test("estate: a plugin-served server whose launcher finds the current binary is left to the plugin", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".local", "bin"), "0.30.0");
    const r = run(sb);
    assert.doesNotMatch(configToml(sb), /mcp_servers/);
    assert.ok(r.garden.notes.some((n) => /served by the plugin; its launcher starts ~\/\.local\/bin\/wicked-estate-mcp \(0\.30\.0\)/.test(n)), r.garden.notes.join("\n"));
  } finally {
    cleanup(sb);
  }
});

test("estate: a binary only in ~/.cargo/bin (off PATH) gets a new config entry — the plugin's launcher cannot find it", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".cargo", "bin"), "0.30.0");
    const r = run(sb);
    assert.match(configToml(sb), new RegExp(`\\[mcp_servers\\.wicked-estate\\]\\ncommand = ${JSON.stringify(join(sb.home, ".cargo", "bin", "wicked-estate-mcp")).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    assert.ok(r.garden.notes.some((n) => /launcher would start nothing/.test(n)), r.garden.notes.join("\n"));
  } finally {
    cleanup(sb);
  }
});

test("estate: a failed MCP step is a note — the plugin and its marker record stay", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".cargo", "bin"), "0.30.0"); // forces a new entry via `codex mcp add`
    const r = run(sb, [], { CODEX_STUB_FAIL: "mcp-add" });
    assert.equal(r.garden.success, true);
    assert.ok(r.garden.notes.some((n) => /wicked-estate MCP repair failed: codex mcp add wicked-estate failed/.test(n)), r.garden.notes.join("\n"));
    assert.ok(marker(sb).products.find((p) => p.id === "wicked-garden").codexPlugin, "marketplace ownership recorded");
  } finally {
    cleanup(sb);
  }
});

test("--dry-run without the global package plans the plugin path instead of the copy path", { skip }, () => {
  const sb = sandbox();
  try {
    rmSync(join(sb.src, "wicked-garden"), { recursive: true });
    const res = spawnSync(process.execPath, [script, "wicked-garden", "--codex-home", sb.codexHome, "--registry", sb.registry, "--source-root", sb.src, "--dry-run", "--json"], {
      encoding: "utf8", env: { PATH: `${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, CODEX_STUB_LOG: sb.log }, timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    const g = JSON.parse(res.stdout.slice(res.stdout.indexOf("{"))).reports.find((x) => x.productId === "wicked-garden");
    assert.equal(g.delivery, "planned");
    assert.ok(g.notes.some((n) => /a real run installs it, then registers it as a Codex plugin/.test(n)), g.notes.join("\n"));
  } finally {
    cleanup(sb);
  }
});

test("estate product registers its resolved binary even when the plugin already serves the name", { skip }, () => {
  const sb = sandbox();
  try {
    fakeEstate(join(sb.home, ".local", "bin"), "0.30.0"); // the plugin's launcher finds it: no entry yet
    assert.equal(run(sb).status, 0);
    const res = spawnSync(process.execPath, [script, "wicked-estate", "--codex-home", sb.codexHome, "--registry", sb.registry, "--source-root", sb.src, "--skip-binaries", "--json"], {
      encoding: "utf8", env: { PATH: `${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, CODEX_STUB_LOG: sb.log }, timeout: 60000,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(configToml(sb), new RegExp(`\\[mcp_servers\\.wicked-estate\\]\\ncommand = "[^"]+wicked-estate-mcp"\\n(?!args)`),
      "the plugin's `wicked-garden run …` args are not carried into the config entry");
    assert.ok(marker(sb).products.some((p) => p.id === "wicked-garden" && p.codexPlugin), "the garden record survives a run for another product");
  } finally {
    cleanup(sb);
  }
});

test("--dry-run writes nothing and runs only read-only codex queries", { skip }, () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.codexHome, { recursive: true });
    skill(join(sb.codexHome, "skills", "wicked-garden-old"), "wicked-garden-old");
    write(join(sb.codexHome, "wicked-installer", "codex-install.json"), JSON.stringify({ products: [{ id: "wicked-garden", success: true, assets: { skills: 1 }, skills: ["wicked-garden-old"] }] }));
    const before = readFileSync(join(sb.codexHome, "wicked-installer", "codex-install.json"), "utf8");
    const r = run(sb, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.garden.delivery, "planned");
    const subs = calls(sb).map((c) => c.argv.join(" "));
    assert.ok(subs.every((c) => /^plugin list --help$|^plugin marketplace list --json$|^plugin list --json$|^mcp get wicked-estate --json$/.test(c)), subs.join("; "));
    assert.ok(existsSync(join(sb.codexHome, "skills", "wicked-garden-old")));
    assert.equal(readFileSync(join(sb.codexHome, "wicked-installer", "codex-install.json"), "utf8"), before);
    assert.ok(r.garden.notes.some((n) => /would remove 1 loose wicked-garden skill/.test(n)));
  } finally {
    cleanup(sb);
  }
});
