// installer#87: the direct path (`install wicked-crew ...`) gives every detected host the skills of a product
// whose package ships them for all hosts (registry install.hostSkills: wicked-bus).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { hostSkillsStep, cliScriptArgs, shellQuote } = await import("../dist/index.js");
const FLAGS = { dryRun: false, force: false, interactive: false, claudeHomes: [] };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };

const host = (cli, displayName) => ({ cli, displayName, scriptPath: `/x/install-${cli}.js`, detected: true, binOnPath: true, homeDetected: true });
const okRun = (calls) => (cli, ids) => { calls.push([cli.cli, ...ids]); return { cli: cli.cli, displayName: cli.displayName, status: 0, present: true, parsed: true, entries: ids.map((productId) => ({ productId, success: true, skipped: false })), rawTail: "" }; };

test("the registry marks wicked-bus (and only npm-global products) for every host's skills", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const marked = reg.products.filter((p) => p.install.hostSkills === true);
  assert.deepEqual(marked.map((p) => p.id), ["wicked-bus"]);
  assert.ok(marked.every((p) => p.install.type === "npm-global"));
});

test("bus in the set: each detected host's own script runs once with just the bus, binaries skipped", () => {
  const calls = [];
  const hosts = [host("claude", "Claude Code"), host("codex", "Codex"), host("opencode", "OpenCode"), host("pi", "Pi"), host("antigravity", "Antigravity")];
  const lines = quiet(() => hostSkillsStep(["wicked-estate", "wicked-bus", "wicked-crew"], FLAGS, { hosts: () => hosts, run: okRun(calls) }));
  assert.deepEqual(calls, hosts.map((h) => [h.cli, "wicked-bus"]));
  assert.equal(lines.length, 5);
  assert.match(lines[0], /Wicked Bus skills added to Claude Code/);
});

test("no hostSkills product in the set: nothing runs and nothing prints", () => {
  const lines = quiet(() => hostSkillsStep(["wicked-crew", "wicked-garden"], FLAGS, { hosts: () => assert.fail("not asked"), run: () => assert.fail("not run") }));
  assert.deepEqual(lines, []);
});

test("--dry-run spawns nothing and prints the plan per host", () => {
  const lines = quiet(() => hostSkillsStep(["wicked-bus"], { ...FLAGS, dryRun: true }, { hosts: () => [host("codex", "Codex"), host("pi", "Pi")], run: () => assert.fail("dry-run") }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^dry-run: would add the skills of Wicked Bus to Codex, Pi/);
});

test("a host that fails is a warning naming its command; the others still get the skills; no host is named once", () => {
  const calls = [];
  const good = okRun(calls);
  const run = (cli, ids) => cli.cli === "pi" ? { cli: "pi", displayName: "Pi", status: 1, present: true, parsed: true, entries: [{ productId: "wicked-bus", success: false, skipped: false, message: "EACCES on the skills dir" }], rawTail: "" } : good(cli, ids);
  const lines = quiet(() => hostSkillsStep(["wicked-bus"], FLAGS, { hosts: () => [host("pi", "Pi"), host("codex", "Codex")], run }));
  assert.match(lines[0], /^warning: Wicked Bus skills were not added to Pi \(EACCES on the skills dir\); run `node \/x\/install-pi\.js wicked-bus --json --skip-binaries`/);
  assert.match(lines[1], /added to Codex/);
  const none = quiet(() => hostSkillsStep(["wicked-bus"], FLAGS, { hosts: () => [], run: () => assert.fail("no host") }));
  assert.match(none[0], /no supported host detected/);
});

// The real route: the bundled host scripts deliver the bus package's nested skills/wicked-bus/<x>/SKILL.md layout.
for (const [cli, homeFlag, homeRel, skillsRel] of [
  ["pi", "--pi-home", join(".pi", "agent"), "skills"],
  ["opencode", "--opencode-home", join(".config", "opencode"), "skills"],
]) {
  test(`install-${cli}.js wicked-bus --skip-binaries copies the bus skills (real package layout)`, { skip: process.platform === "win32" ? "POSIX fixture paths" : false }, () => {
    const home = mkdtempSync(join(tmpdir(), "wicked-host-skills-"));
    try {
      const src = join(home, "src");
      cpSync(join(ROOT, "tests", "fixtures", "wicked-bus-mini"), join(src, "wicked-bus"), { recursive: true });
      const env = { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" };
      const r = spawnSync(process.execPath, [join(ROOT, "dist", `install-${cli}.js`), "wicked-bus", "--skip-binaries", "--source-root", src, homeFlag, join(home, homeRel), "--json"], { encoding: "utf8", env, timeout: 60_000 });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const dir = join(home, homeRel, skillsRel);
      const got = existsSync(dir) ? readdirSync(dir).filter((d) => /emit|status/.test(d)).sort() : [];
      assert.equal(got.length, 2, `skills in ${dir}: ${existsSync(dir) ? readdirSync(dir).join(", ") : "none"}\n${r.stdout}`);
      for (const d of got) {
        const body = readFileSync(join(dir, d, "SKILL.md"), "utf8");
        assert.match(body, /^---\nname: \S+/, `${d}/SKILL.md has frontmatter`);
        assert.match(body, d.includes("emit") ? /Emit events to the wicked-bus/ : /^description: /m, `${d}/SKILL.md is the bus skill`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("the retry line is the same invocation (target and source kept), and a zero-skill report is a warning", () => {
  const flags = { ...FLAGS, force: true, sourceRoot: "/src/my checkout", claudeHomes: ["/work/claude"] };
  const run = (cli) => ({ cli: cli.cli, displayName: cli.displayName, status: 0, present: true, parsed: true, entries: [{ productId: "wicked-bus", success: true, skipped: false, assets: { skills: 0 } }], rawTail: "" });
  const lines = quiet(() => hostSkillsStep(["wicked-bus"], flags, { hosts: () => [host("claude", "Claude Code")], run }));
  assert.match(lines[0], /copied no skills/);
  assert.ok(lines[0].includes("--force --source-root '/src/my checkout' --claude-home /work/claude"), lines[0]);
  assert.doesNotMatch(lines[0], /--dry-run/);
  // The run and the retry share one builder: --json and --skip-binaries always, --claude-home only for Claude.
  assert.deepEqual(cliScriptArgs(host("codex", "Codex"), ["wicked-bus"], flags, true), ["/x/install-codex.js", "wicked-bus", "--json", "--skip-binaries", "--force", "--source-root", "/src/my checkout"]);
});

test("the retry line survives a POSIX shell: a path with $, a quote or a space reaches the script unchanged", { skip: process.platform === "win32" ? "POSIX sh" : false }, () => {
  const odd = "/tmp/claude$cash it's";
  const flags = { ...FLAGS, sourceRoot: "/src/a&b", claudeHomes: [odd] };
  const bad = (cli) => ({ cli: cli.cli, displayName: cli.displayName, status: 1, present: true, parsed: false, entries: [], rawTail: "" });
  const [line] = quiet(() => hostSkillsStep(["wicked-bus"], flags, { hosts: () => [host("claude", "Claude Code")], run: bad, platform: "linux" }));
  const cmd = line.match(/run `node (.*)`$/)[1];
  // Echo each argument the shell hands over, one per line, in place of running the script.
  const r = spawnSync("/bin/sh", ["-c", `printf '%s\\n' ${cmd}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", cash: "EXPANDED" } });
  const argv = r.stdout.split("\n").slice(0, -1);
  assert.deepEqual(argv, cliScriptArgs(host("claude", "Claude Code"), ["wicked-bus"], flags, true));
  assert.equal(shellQuote('C:\\Users\\a b\\"x"', "win32"), '"C:\\Users\\a b\\""x"""');
});

// installer#87, DES B (approved 2026-11-27): one rule on all five hosts. A same-named skill dir this installer's marker
// does not record is MOVED to <host home>/wicked-installer/kept-skills/ (content intact), then the skill installs.
test("Claude's real script moves a foreign same-named skill dir aside, and the step says where it went", { skip: process.platform === "win32" ? "POSIX fixture paths" : false }, () => {
  const home = mkdtempSync(join(tmpdir(), "wicked-host-skills-"));
  try {
    const src = join(home, "src");
    cpSync(join(ROOT, "tests", "fixtures", "wicked-bus-mini"), join(src, "wicked-bus"), { recursive: true });
    const claudeHome = join(home, ".claude");
    // A skill dir with the bus's install name that this installer never wrote (no marker, no signature).
    mkdirSync(join(claudeHome, "skills", "wicked-bus-emit"), { recursive: true });
    writeFileSync(join(claudeHome, "skills", "wicked-bus-emit", "SKILL.md"), "---\nname: someone-elses\n---\nmine\n");
    const env = { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" };
    const run = (cli, ids) => {
      const r = spawnSync(process.execPath, [join(ROOT, "dist", "install-claude.js"), ...ids, "--skip-binaries", "--source-root", src, "--claude-home", claudeHome, "--json"], { encoding: "utf8", env, timeout: 60_000 });
      const report = JSON.parse(r.stdout);
      return { cli: cli.cli, displayName: cli.displayName, status: r.status, present: true, parsed: true, entries: report.reports, rawTail: "" };
    };
    const lines = quiet(() => hostSkillsStep(["wicked-bus"], FLAGS, { hosts: () => [host("claude", "Claude Code")], run, platform: "linux" })).map(strip);
    const keptDir = join(claudeHome, "wicked-installer", "kept-skills");
    const kept = readdirSync(keptDir).filter((d) => d.startsWith("wicked-bus-emit-"));
    assert.equal(kept.length, 1, readdirSync(keptDir).join(", "));
    assert.equal(readFileSync(join(keptDir, kept[0], "SKILL.md"), "utf8"), "---\nname: someone-elses\n---\nmine\n", "the person's dir is kept intact");
    assert.deepEqual(lines, [
      "Wicked Bus skills added to Claude Code",
      `Claude Code: skills/wicked-bus-emit was not written by the installer; moved to ${join(keptDir, kept[0])} before the install`,
    ]);
    assert.doesNotMatch(readFileSync(join(claudeHome, "skills", "wicked-bus-emit", "SKILL.md"), "utf8"), /someone-elses/, "the bus skill is installed in its place");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// codex-check on 0025669 and b7d57d1 (W20): a person's own same-named skill dir was overwritten (four hosts) or adopted
// and deleted (Claude). Each host's real script, run as the direct path runs it.
for (const [cli, homeFlag, homeRel, skillsRel, targetOf] of [
  ["claude", "--claude-home", ".claude", "skills", () => "skills/wicked-bus-emit"],
  ["pi", "--pi-home", join(".pi", "agent"), "skills", (abs) => abs],
  ["opencode", "--opencode-home", join(".config", "opencode"), "skills", (abs) => abs],
  ["codex", "--codex-home", ".codex", "skills", (abs) => abs],
  ["antigravity", "--gemini-home", ".gemini", join("config", "skills"), (abs) => abs],
]) {
  test(`install-${cli}.js moves an unrecorded same-named skill dir to kept-skills, content intact, then installs; its own recorded copy is replaced in place; --dry-run moves nothing`, { skip: process.platform === "win32" ? "POSIX fixture paths" : false }, () => {
    const home = mkdtempSync(join(tmpdir(), "wicked-host-skills-"));
    try {
      const src = join(home, "src");
      cpSync(join(ROOT, "tests", "fixtures", "wicked-bus-mini"), join(src, "wicked-bus"), { recursive: true });
      const hostHome = join(home, homeRel);
      const skills = join(hostHome, skillsRel);
      const mine = join(skills, "wicked-bus-emit");
      const MINE = "---\nname: wicked-bus-emit\n---\nLOCAL CUSTOM CONTENT\n";
      mkdirSync(mine, { recursive: true });
      // The person's own skill under the bus's install name, even naming itself as the bus skill does: the marker decides.
      writeFileSync(join(mine, "SKILL.md"), MINE);
      const env = { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" };
      const run = (...extra) => spawnSync(process.execPath, [join(ROOT, "dist", `install-${cli}.js`), "wicked-bus", "--skip-binaries", "--source-root", src, homeFlag, hostHome, "--json", ...extra], { encoding: "utf8", env, timeout: 60_000 });
      const keptDir = join(hostHome, "wicked-installer", "kept-skills");

      const dry = run("--dry-run");
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      assert.equal(readFileSync(join(mine, "SKILL.md"), "utf8"), MINE, "--dry-run leaves the dir in place");
      assert.equal(existsSync(keptDir), false, "--dry-run moves nothing");

      const r = run();
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const kept = readdirSync(keptDir).filter((d) => d.startsWith("wicked-bus-emit-"));
      assert.equal(kept.length, 1, readdirSync(keptDir).join(", "));
      assert.equal(readFileSync(join(keptDir, kept[0], "SKILL.md"), "utf8"), MINE, "the person's dir is kept intact");
      assert.doesNotMatch(readFileSync(join(mine, "SKILL.md"), "utf8"), /LOCAL CUSTOM CONTENT/, "the bus skill is installed in its place");
      const entry = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
      const moved = (entry.actions ?? []).filter((a) => a.kind === "collision-moved");
      assert.deepEqual(moved.map((a) => [a.target, a.result]), [[targetOf(mine), "ok"]], JSON.stringify(entry.actions));
      assert.match(moved[0].detail, new RegExp(`moved to ${join(keptDir, kept[0]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} before the install`));
      assert.equal(readdirSync(skills).filter((d) => /status/.test(d)).length, 1, readdirSync(skills).join(", "));

      // The installer's own copy is recorded in its marker: a second run replaces it in place and moves nothing.
      const again = run();
      assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
      const entry2 = JSON.parse(again.stdout).reports.find((e) => e.productId === "wicked-bus");
      assert.deepEqual((entry2.actions ?? []).filter((a) => a.kind === "collision-moved" || a.kind === "collision-skipped"), [], JSON.stringify(entry2.actions));
      assert.equal(readdirSync(keptDir).length, 1, "nothing more was moved");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
