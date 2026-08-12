// pack.test.mjs — the pack add/remove path (extension contract, gap 7).
//
// Network-free: WICKED_GARDEN_BIN points at tests/garden-stub.mjs so the
// delegated check/register/unregister calls are recorded instead of hitting
// npm/npx, and HOME is redirected to a temp dir so installs land in a
// sandbox. Requires `npm run build` first (CI does build before test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const STUB = join(__dirname, "garden-stub.mjs");
const FIXTURE = join(__dirname, "fixtures", "acme-mini");

function runPack(args, { home, stubLog, stubExit } = {}) {
  return spawnSync(process.execPath, [CLI, "pack", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home ?? process.env.HOME,
      USERPROFILE: home ?? process.env.USERPROFILE, // windows homedir()
      WICKED_GARDEN_BIN: STUB,
      GARDEN_STUB_LOG: stubLog ?? "",
      GARDEN_STUB_EXIT: String(stubExit ?? 0),
    },
  });
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), "wicked-pack-home-"));
}

function stubCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("unit: parsePackArgs keeps flag values out of positionals", async () => {
  const { parsePackArgs } = await import("../dist/pack.js");
  const { positionals, flags } = parsePackArgs(
    ["add", "--source-url", "https://x.test/repo", "./some-pack", "--dry-run"]);
  assert.deepEqual(positionals, ["add", "./some-pack"]);
  assert.equal(flags.sourceUrl, "https://x.test/repo");
  assert.equal(flags.dryRun, true);
  assert.equal(flags.force, false);
});

test("unit: npmSpecName strips versions, keeps scopes", async () => {
  const { npmSpecName } = await import("../dist/pack.js");
  assert.equal(npmSpecName("acme-seo-pack"), "acme-seo-pack");
  assert.equal(npmSpecName("acme-seo-pack@1.2.3"), "acme-seo-pack");
  assert.equal(npmSpecName("@acme/seo-pack"), "@acme/seo-pack");
  assert.equal(npmSpecName("@acme/seo-pack@next"), "@acme/seo-pack");
});

test("pack add: local dir → validate, install, copy skills, register", () => {
  chmodSync(STUB, 0o755);
  const home = freshHome();
  const stubLog = join(home, "stub.log");
  try {
    const res = runPack(["add", FIXTURE, "--source-url", "https://github.com/acme/acme-mini"],
                        { home, stubLog });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    // canonical install home
    const installed = join(home, ".something-wicked", "wicked-garden", "packs", "installed", "acme-mini");
    assert.ok(existsSync(join(installed, "wicked-pack.json")), "pack copied to install home");

    // skills visible to Claude Code
    assert.ok(existsSync(join(home, ".claude", "skills", "acme-mini", "SKILL.md")));
    assert.ok(existsSync(join(home, ".claude", "skills", "acme-mini-widget-maker", "SKILL.md")));

    // delegation: exactly check → register, against the garden CLI (one impl)
    const calls = stubCalls(stubLog);
    assert.deepEqual(calls[0].slice(0, 2), ["pack", "check"]);
    assert.equal(calls[1][0], "pack");
    assert.equal(calls[1][1], "register");
    assert.equal(calls[1][2], installed);
    assert.deepEqual(calls[1].slice(3), ["--source", "https://github.com/acme/acme-mini"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pack add: conformance failure blocks install (no --force)", () => {
  chmodSync(STUB, 0o755);
  const home = freshHome();
  const stubLog = join(home, "stub.log");
  try {
    const res = runPack(["add", FIXTURE], { home, stubLog, stubExit: 1 });
    assert.equal(res.status, 1);
    const installed = join(home, ".something-wicked", "wicked-garden", "packs", "installed", "acme-mini");
    assert.ok(!existsSync(installed), "nothing installed after failed gate");
    assert.ok(!existsSync(join(home, ".claude", "skills", "acme-mini")));
    // only the check call happened — no register
    assert.equal(stubCalls(stubLog).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pack add --dry-run writes nothing", () => {
  chmodSync(STUB, 0o755);
  const home = freshHome();
  const stubLog = join(home, "stub.log");
  try {
    const res = runPack(["add", FIXTURE, "--dry-run"], { home, stubLog });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(!existsSync(join(home, ".something-wicked")));
    assert.ok(!existsSync(join(home, ".claude")));
    // check ran; register did not
    const calls = stubCalls(stubLog);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "check");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pack remove: deletes skills + install home, unregisters", () => {
  chmodSync(STUB, 0o755);
  const home = freshHome();
  const stubLog = join(home, "stub.log");
  try {
    assert.equal(runPack(["add", FIXTURE], { home, stubLog }).status, 0);
    const res = runPack(["remove", "acme-mini"], { home, stubLog });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(!existsSync(join(home, ".something-wicked", "wicked-garden", "packs", "installed", "acme-mini")));
    assert.ok(!existsSync(join(home, ".claude", "skills", "acme-mini")));
    assert.ok(!existsSync(join(home, ".claude", "skills", "acme-mini-widget-maker")));
    const calls = stubCalls(stubLog);
    assert.deepEqual(calls[calls.length - 1], ["pack", "unregister", "acme-mini"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pack add: non-pack directory is rejected", () => {
  const home = freshHome();
  try {
    const res = runPack(["add", __dirname], { home });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a pack/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pack help lists the verbs", () => {
  const res = runPack([], {});
  assert.equal(res.status, 0);
  assert.match(res.stdout, /pack add <dir\|npm-spec>/);
  assert.match(res.stdout, /docs\/extending\.md/);
});
