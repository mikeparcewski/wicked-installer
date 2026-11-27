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

test("Claude's real script leaves a foreign same-named skill dir alone: the step names it instead of 'skills added'", { skip: process.platform === "win32" ? "POSIX fixture paths" : false }, () => {
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
    const lines = quiet(() => hostSkillsStep(["wicked-bus"], FLAGS, { hosts: () => [host("claude", "Claude Code")], run, platform: "linux" }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warning: Wicked Bus skills were added to Claude Code, but 1 was left alone: skills\/wicked-bus-emit \(foreign skill dir present; rename it and re-run\); then run `node /, lines[0]);
    assert.equal(readFileSync(join(claudeHome, "skills", "wicked-bus-emit", "SKILL.md"), "utf8").includes("mine"), true, "the foreign dir is untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// codex-check on 0025669 (W20): the other host scripts overwrote a same-named skill dir they did not write.
for (const [cli, homeFlag, homeRel, skillsRel] of [
  ["pi", "--pi-home", join(".pi", "agent"), "skills"],
  ["opencode", "--opencode-home", join(".config", "opencode"), "skills"],
  ["codex", "--codex-home", ".codex", "skills"],
  ["antigravity", "--gemini-home", ".gemini", join("config", "skills")],
]) {
  test(`install-${cli}.js leaves a foreign same-named skill dir alone and reports it, whatever its SKILL.md names; its own recorded copy is not reported`, { skip: process.platform === "win32" ? "POSIX fixture paths" : false }, () => {
    const home = mkdtempSync(join(tmpdir(), "wicked-host-skills-"));
    try {
      const src = join(home, "src");
      cpSync(join(ROOT, "tests", "fixtures", "wicked-bus-mini"), join(src, "wicked-bus"), { recursive: true });
      const skills = join(home, homeRel, skillsRel);
      const foreign = join(skills, "wicked-bus-emit");
      mkdirSync(foreign, { recursive: true });
      // The person's own skill under the bus's install name, even naming itself as the bus skill does: the marker decides.
      writeFileSync(join(foreign, "SKILL.md"), "---\nname: wicked-bus-emit\n---\nmine\n");
      const env = { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" };
      const run = () => spawnSync(process.execPath, [join(ROOT, "dist", `install-${cli}.js`), "wicked-bus", "--skip-binaries", "--source-root", src, homeFlag, join(home, homeRel), "--json"], { encoding: "utf8", env, timeout: 60_000 });
      const r = run();
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "---\nname: wicked-bus-emit\n---\nmine\n", "the foreign dir is untouched");
      const entry = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
      assert.deepEqual(entry.actions?.map((a) => [a.kind, a.target, a.result]), [["collision-skipped", foreign, "skipped"]]);
      const own = readdirSync(skills).filter((d) => /status/.test(d));
      assert.equal(own.length, 1, readdirSync(skills).join(", "));
      // The installer's own copy (recorded in its marker) is not foreign: a second run reports only the person's dir.
      const again = JSON.parse(run().stdout).reports.find((e) => e.productId === "wicked-bus");
      assert.deepEqual(again.actions?.map((a) => a.target), [foreign]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
