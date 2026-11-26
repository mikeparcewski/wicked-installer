// installer#87: the direct path (`install wicked-crew ...`) gives every detected host the skills of a product
// whose package ships them for all hosts (registry install.hostSkills: wicked-bus).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { hostSkillsStep } = await import("../dist/index.js");
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
  const lines = quiet(() => hostSkillsStep(["wicked-estate", "wicked-bus", "wicked-crew"], { dryRun: false }, { hosts: () => hosts, run: okRun(calls) }));
  assert.deepEqual(calls, hosts.map((h) => [h.cli, "wicked-bus"]));
  assert.equal(lines.length, 5);
  assert.match(lines[0], /Wicked Bus skills added to Claude Code/);
});

test("no hostSkills product in the set: nothing runs and nothing prints", () => {
  const lines = quiet(() => hostSkillsStep(["wicked-crew", "wicked-garden"], { dryRun: false }, { hosts: () => assert.fail("not asked"), run: () => assert.fail("not run") }));
  assert.deepEqual(lines, []);
});

test("--dry-run spawns nothing and prints the plan per host", () => {
  const lines = quiet(() => hostSkillsStep(["wicked-bus"], { dryRun: true }, { hosts: () => [host("codex", "Codex"), host("pi", "Pi")], run: () => assert.fail("dry-run") }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^dry-run: would add the skills of Wicked Bus to Codex, Pi/);
});

test("a host that fails is a warning naming its command; the others still get the skills; no host is named once", () => {
  const calls = [];
  const good = okRun(calls);
  const run = (cli, ids) => cli.cli === "pi" ? { cli: "pi", displayName: "Pi", status: 1, present: true, parsed: true, entries: [{ productId: "wicked-bus", success: false, skipped: false, message: "EACCES on the skills dir" }], rawTail: "" } : good(cli, ids);
  const lines = quiet(() => hostSkillsStep(["wicked-bus"], { dryRun: false }, { hosts: () => [host("pi", "Pi"), host("codex", "Codex")], run }));
  assert.match(lines[0], /^warning: Wicked Bus skills were not added to Pi \(EACCES on the skills dir\); run `node "\/x\/install-pi\.js" wicked-bus --skip-binaries`/);
  assert.match(lines[1], /added to Codex/);
  const none = quiet(() => hostSkillsStep(["wicked-bus"], { dryRun: false }, { hosts: () => [], run: () => assert.fail("no host") }));
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
      const got = existsSync(dir) ? readdirSync(dir).filter((d) => /emit|status/.test(d)) : [];
      assert.equal(got.length, 2, `skills in ${dir}: ${existsSync(dir) ? readdirSync(dir).join(", ") : "none"}\n${r.stdout}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
