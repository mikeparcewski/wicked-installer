// readiness.test.mjs — "copied" / "registered" is not "ready" (EXP-01).
//
// The readiness check (dist/readiness.js) answers, per capability, whether what was delivered can
// RUN here: the launcher on PATH and its self-check, a Python 3 at the floor, the backend binary.
// An `npx` fallback is never counted as ready — it resolves at first use and fails offline.
// Every case runs against fake executables on a PATH that holds nothing else, with HOME set to
// a throwaway directory. Requires `npm run build` first (CI builds before test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { preflight, versionAtLeast } = await import("../dist/readiness.js");

const POSIX = process.platform !== "win32";
const skip = POSIX ? false : "fake executables are POSIX sh scripts";

/** A product shaped like the registry's wicked-garden entry. */
const GARDEN = {
  id: "wicked-garden",
  status: "active",
  capabilities: [
    {
      id: "skill-scripts",
      label: "script-backed skills",
      hosts: ["codex", "opencode", "pi", "antigravity"],
      needs: [
        { kind: "launcher", bin: "wicked-garden", npx: "wicked-garden", doctor: ["doctor"] },
        { kind: "python", min: "3.10" },
      ],
    },
    { id: "plugin-scripts", label: "plugin scripts", hosts: ["claude"], needs: [{ kind: "python", min: "3.10" }] },
    { id: "evidence-gate", label: "evidence gate", needs: [{ kind: "backend", bin: "wicked-vault", npx: "wicked-vault" }] },
    { id: "mem-search", label: "mem/search", optional: true, needs: [{ kind: "backend", bin: "wicked-estate-mcp" }] },
  ],
};

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-readiness-"));
  const bin = join(tmp, "bin");
  const home = join(tmp, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const log = join(tmp, "spawn.log");
  const env = { PATH: bin, HOME: home, USERPROFILE: home };
  /** A fake executable: logs its argv, prints `out`, exits `code`. */
  const fake = (name, out, code = 0) =>
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nprintf '%s\\n' '${out.replace(/'/g, "'\\''")}'\nexit ${code}\n`, { mode: 0o755 });
  const spawned = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { tmp, env, fake, spawned, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const by = (rows, id) => rows.find((r) => r.capability === id);

test("versionAtLeast compares numerically", () => {
  assert.ok(versionAtLeast("Python 3.12.1", "3.10"));
  assert.ok(versionAtLeast("Python 3.10.0", "3.10"));
  assert.ok(!versionAtLeast("Python 3.9.18", "3.10"));
  assert.ok(!versionAtLeast("no version", "3.10"));
});

test("clean machine, online: copied skills are PENDING — the npx fallback is reachable but not ready", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("npm", "12.48.0");
    sb.fake("python3", "Python 3.12.1");
    const rows = preflight([GARDEN], { hosts: ["codex"], env: sb.env, platform: "linux" });
    assert.deepEqual(rows.map((r) => r.capability), ["skill-scripts", "evidence-gate", "mem-search"], "hosts filter: no Claude-only capability for a Codex target");
    const skills = by(rows, "skill-scripts");
    assert.equal(skills.state, "pending");
    const launcher = skills.needs.find((n) => n.need === "launcher wicked-garden");
    assert.equal(launcher.met, false);
    assert.match(launcher.detail, /only the `npx wicked-garden` fallback is available — npm registry answers \(wicked-garden@12\.48\.0\), but it fetches at first use and fails offline/);
    assert.match(launcher.remedy, /npm i -g wicked-garden/);
    assert.equal(skills.needs.find((n) => n.need === "python >= 3.10").met, true);
    assert.equal(by(rows, "evidence-gate").state, "pending");
    assert.equal(by(rows, "mem-search").optional, true);
    assert.match(sb.spawned(), /npm view wicked-garden version/);
    assert.match(sb.spawned(), /npm view wicked-vault version/);
  } finally {
    sb.cleanup();
  }
});

test("clean machine, offline (registry unreachable): pending, and the fallback is reported as unable to resolve", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("npm", "npm ERR! code ENOTFOUND", 1);
    const rows = preflight([GARDEN], { hosts: ["codex"], env: sb.env, platform: "linux" });
    const launcher = by(rows, "skill-scripts").needs[0];
    assert.equal(launcher.met, false);
    assert.match(launcher.detail, /not on PATH, and the `npx wicked-garden` fallback cannot resolve it: npm registry unreachable/);
    const python = by(rows, "skill-scripts").needs[1];
    assert.equal(python.met, false);
    assert.match(python.detail, /no python3 \/ python on PATH/);
  } finally {
    sb.cleanup();
  }
});

test("--offline: no network lookup at all; the fallback is reported as not checked", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("npm", "12.48.0");
    const rows = preflight([GARDEN], { hosts: ["codex"], env: sb.env, platform: "linux", offline: true });
    assert.match(by(rows, "skill-scripts").needs[0].detail, /fallback was not checked \(--offline\)/);
    assert.doesNotMatch(sb.spawned(), /npm/, "npm was never spawned");
  } finally {
    sb.cleanup();
  }
});

test("launcher installed and its self-check passes, python at the floor, backend present: READY", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("wicked-garden", JSON.stringify({ ok: true, python: { kind: "python3", version: "Python 3.12.1" } }));
    sb.fake("python3", "Python 3.12.1");
    sb.fake("wicked-vault", "");
    const rows = preflight([GARDEN], { hosts: ["codex"], env: sb.env, platform: "linux" });
    assert.equal(by(rows, "skill-scripts").state, "ready");
    assert.match(by(rows, "skill-scripts").needs[0].detail, /`wicked-garden doctor` ok, python Python 3\.12\.1/);
    assert.equal(by(rows, "evidence-gate").state, "ready");
    assert.equal(by(rows, "mem-search").state, "pending", "optional backend absent stays pending");
    assert.match(sb.spawned(), /wicked-garden doctor/);
    assert.doesNotMatch(sb.spawned(), /wicked-vault/, "a backend without a doctor is a PATH probe, never run");
  } finally {
    sb.cleanup();
  }
});

test("launcher on PATH but its self-check fails, or Python below the floor: pending with the reason", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("wicked-garden", JSON.stringify({ ok: false, python: { kind: null, reason: "no Python 3 found (.venv / uv / python3 / python / py)" } }), 1);
    sb.fake("python3", "Python 3.9.18");
    const rows = preflight([GARDEN], { hosts: ["codex"], env: sb.env, platform: "linux" });
    const [launcher, python] = by(rows, "skill-scripts").needs;
    assert.equal(launcher.met, false);
    assert.match(launcher.detail, /self-check failed: no Python 3 found/);
    assert.equal(python.met, false);
    assert.match(python.detail, /no interpreter at or above 3\.10 \(python3: Python 3\.9\.18\)/);
  } finally {
    sb.cleanup();
  }
});

test("a self-check that prints ok but exits nonzero is not trusted", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("wicked-garden", JSON.stringify({ ok: true }), 3);
    const rows = preflight([GARDEN], { hosts: ["codex"], env: sb.env, platform: "linux" });
    const launcher = by(rows, "skill-scripts").needs[0];
    assert.equal(launcher.met, false);
    assert.match(launcher.detail, /self-check failed: self-check exited 3/);
  } finally {
    sb.cleanup();
  }
});

test("--dry-run (probeOnly): nothing is spawned — PATH probes only", { skip }, () => {
  const sb = sandbox();
  try {
    sb.fake("wicked-garden", "{}");
    sb.fake("python3", "Python 3.12.1");
    sb.fake("npm", "1.0.0");
    const rows = preflight([GARDEN], { hosts: ["codex", "claude"], env: sb.env, platform: "linux", probeOnly: true });
    assert.equal(sb.spawned(), "", "no executable ran");
    assert.match(by(rows, "skill-scripts").needs[0].detail, /not run under --dry-run/);
    assert.match(by(rows, "evidence-gate").needs[0].detail, /fallback was not checked \(--dry-run\)/);
    assert.ok(by(rows, "plugin-scripts"), "a Claude target brings the Claude capability");
  } finally {
    sb.cleanup();
  }
});

test("the registry declares garden's runtime needs — launcher, python, vault backend", () => {
  const reg = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const garden = reg.products.find((p) => p.id === "wicked-garden");
  const needs = garden.capabilities.flatMap((c) => c.needs.map((n) => `${n.kind}:${n.bin ?? n.min}`));
  for (const n of ["launcher:wicked-garden", "python:3.10", "backend:wicked-vault"]) assert.ok(needs.includes(n), n);
  for (const p of reg.products) {
    for (const c of p.capabilities ?? []) {
      assert.ok(typeof c.id === "string" && typeof c.label === "string" && Array.isArray(c.needs) && c.needs.length > 0, `${p.id}/${c.id} shape`);
      for (const n of c.needs) assert.ok(["launcher", "backend", "python"].includes(n.kind), `${p.id}/${c.id} need kind ${n.kind}`);
    }
  }
});
