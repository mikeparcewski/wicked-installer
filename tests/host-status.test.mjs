// host-status.test.mjs — `status` checks wicked-garden PER HOST (it used to check only a Claude Code
// plugin registration, so Codex / OpenCode / Pi / Antigravity homes the installer had just written
// to read "not installed" and exited 1), uninstall never installs (#49), and readiness says plainly
// when a host has no hook events. Isolated temp HOMEs; PATH holds no CLIs. Requires `npm run build`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "index.js");

function run(args, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnv };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_HOME", "PI_CODING_AGENT_DIR", "OPENCODE_CONFIG"]) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  r.out = `${r.stdout}${r.stderr}`;
  return r;
}

function writeMarker(home, rel, cli, entry) {
  const dir = join(home, rel, "wicked-installer");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cli}-install.json`), JSON.stringify({ installedAt: "2026-11-05T00:00:00Z", products: [entry] }));
}

function skill(dir, name) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

const fresh = () => mkdtempSync(join(tmpdir(), "wicked-host-status-"));

test("status: garden installed on Pi (copied skills) is installed — exit 0, no Claude needed", () => {
  const home = fresh();
  try {
    writeMarker(home, join(".pi", "agent"), "pi", { id: "wicked-garden", success: true, skipped: false, assets: { skills: 2 } });
    skill(join(home, ".pi", "agent", "skills"), "wicked-garden-mem");
    skill(join(home, ".pi", "agent", "skills"), "wicked-garden-prove");
    const r = run([CLI, "status", "--offline"], home);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✓ installed\s+wicked-garden\s+\(Pi\)/);
    assert.match(r.out, /Pi\s+✓ installed\s+2 skill dir\(s\)/);
    assert.match(r.out, /wicked-garden: installed on Pi/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: garden as a Codex plugin is installed when Codex's cached payload exists, broken when it is gone", () => {
  const home = fresh();
  try {
    writeMarker(home, ".codex", "codex", {
      id: "wicked-garden", success: true, skipped: false, assets: { skills: 140 },
      codexPlugin: { pluginId: "wicked-garden@wicked-garden", marketplace: "wicked-garden", source: "/x", version: "12.64.0", addedByInstaller: true, enabled: true },
    });
    const cache = join(home, ".codex", "plugins", "cache", "wicked-garden", "wicked-garden", "12.64.0");
    mkdirSync(cache, { recursive: true });
    const ok = run([CLI, "status", "--offline"], home);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /Codex\s+✓ installed\s+Codex plugin wicked-garden@wicked-garden 12\.64\.0/);

    rmSync(cache, { recursive: true, force: true });
    const broken = run([CLI, "status", "--offline"], home);
    assert.equal(broken.status, 1, broken.out);
    assert.match(broken.out, /Codex\s+✗ broken\s+the marker records Codex plugin .* but its payload .* is missing/);
    assert.match(broken.out, /wicked-garden: not installed on any host/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: a host marker whose skills are gone is broken (exit 1), never installed", () => {
  const home = fresh();
  try {
    writeMarker(home, join(".config", "opencode"), "opencode", { id: "wicked-garden", success: true, skipped: false, assets: { skills: 93 } });
    writeMarker(home, join(".pi", "agent"), "pi", { id: "wicked-garden", success: true, skipped: false, assets: { skills: 1 } });
    skill(join(home, ".pi", "agent", "skills"), "wicked-garden-mem");
    const r = run([CLI, "status", "--offline"], home);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /OpenCode\s+✗ broken\s+the marker records 93 skill\(s\), but none are in/);
    assert.match(r.out, /wicked-garden: installed on Pi; broken on OpenCode/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: garden on no host at all exits 1 and says so", () => {
  const home = fresh();
  try {
    const r = run([CLI, "status", "--offline"], home);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /wicked-garden: not installed on any host/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const cli of ["codex", "opencode", "pi", "antigravity"]) {
  test(`#49: install-${cli}.js uninstall --all refuses — it never plans or runs an install`, () => {
    const home = fresh();
    try {
      const script = join(ROOT, "dist", `install-${cli}.js`);
      const r = run([script, "uninstall", "--all", "--dry-run", "--json"], home);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, new RegExp(`install-${cli}\\.js: \`uninstall\` is not supported by this script yet .* nothing was installed, removed or changed`));
      assert.doesNotMatch(r.out, /npm install|cargo install|dry-run: /, "no install plan");
      assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { verb: "uninstall", supported: false, reports: [] });
      assert.deepEqual(readdirSync(home), [], "nothing written to HOME");

      const st = run([script, "status"], home);
      assert.equal(st.status, 1, st.out);
      assert.match(st.stderr, /`status` is not supported by this script yet/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("#49: the central `uninstall` and unknown commands refuse instead of opening the install picker", () => {
  const home = fresh();
  try {
    const u = run([CLI, "uninstall", "--all"], home);
    assert.equal(u.status, 1, u.out);
    assert.match(u.stderr, /no central `uninstall` yet .* nothing was installed, removed or changed/);
    assert.match(u.stderr, /install-claude\.js uninstall --all/);
    const x = run([CLI, "install-opencode", "wicked-garden", "--dry-run"], home);
    assert.equal(x.status, 1, x.out);
    assert.match(x.stderr, /Unknown command: install-opencode/);
    assert.deepEqual(readdirSync(home), [], "nothing written to HOME");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readiness: a host without hook events gets a plain `n/a hooks` row; Claude Code does not", async () => {
  const { preflight } = await import("../dist/readiness.js");
  const { getProduct } = await import("../dist/registry.js");
  const garden = getProduct("wicked-garden");
  assert.equal(garden.shipsHooks, true, "registry marks garden as shipping hooks");
  const rows = preflight([garden], { hosts: ["claude", "codex", "opencode", "pi", "antigravity"], probeOnly: true, env: { PATH: "" } });
  const hooks = rows.filter((r) => r.capability.startsWith("hooks:"));
  assert.deepEqual(hooks.map((r) => r.capability), ["hooks:codex", "hooks:opencode", "hooks:pi", "hooks:antigravity"]);
  for (const r of hooks) {
    assert.equal(r.state, "n/a");
    assert.match(r.label, /has no hook events, so no wicked-garden hook was installed and nothing blocks on its own there: the evidence gate runs only when a skill calls it/);
  }
  assert.match(hooks.find((r) => r.capability === "hooks:pi").label, /^hooks — Pi has no hook events/);

  // And the rendered status shows it for a detected hookless host.
  const home = fresh();
  try {
    writeMarker(home, join(".pi", "agent"), "pi", { id: "wicked-garden", success: true, skipped: false, assets: { skills: 1 } });
    skill(join(home, ".pi", "agent", "skills"), "wicked-garden-mem");
    const r = run([CLI, "status", "--offline"], home);
    assert.match(r.out, /n\/a\s+wicked-garden — hooks — Pi has no hook events/);
    assert.ok(!existsSync(join(home, ".claude")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
