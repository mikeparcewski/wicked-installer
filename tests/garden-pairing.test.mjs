// garden#1600: the installer refuses to pair a garden with a crew older than the garden's core-ts floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { gardenPairing, gardenCoreFloor, installedCoreTs } = await import("../dist/garden-pairing.js");
const { pairingRefused } = await import("../dist/index.js");
const skip = process.platform === "win32" ? "POSIX launcher symlinks" : false;
const quiet = (fn) => { const o = console.log; const out = []; console.log = (...a) => out.push(a.join(" ")); try { return { r: fn(), out: out.join("\n") }; } finally { console.log = o; } };

/** A global wicked-crew whose launcher is on PATH and whose engine is core-ts `core` (nested, or beside it). */
function sandbox(t, core, { beside = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-pairing-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const bin = join(tmp, "bin");
  const nm = join(tmp, "prefix", "lib", "node_modules");
  const crew = join(nm, "wicked-crew");
  mkdirSync(join(crew, "dist"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(crew, "package.json"), JSON.stringify({ name: "wicked-crew", version: "0.7.32" }));
  writeFileSync(join(crew, "dist", "cli.js"), "", { mode: 0o755 });
  symlinkSync(join(crew, "dist", "cli.js"), join(bin, "wicked-crew"));
  if (core) {
    const ts = beside ? join(nm, "wicked-core-ts") : join(crew, "node_modules", "wicked-core-ts");
    mkdirSync(ts, { recursive: true });
    writeFileSync(join(ts, "package.json"), JSON.stringify({ name: "wicked-core-ts", version: core }));
  }
  return { PATH: bin, HOME: join(tmp, "home") };
}

// `npm view wicked-garden@latest version wicked --json` prints this object for garden#1602's package.json.
const GARDEN_1602 = { version: "12.69.1", wicked: { coreTsFloor: "0.9.0" } };

test("an old crew (core-ts 0.8.5) is refused garden, before anything installs, with 'upgrade wicked-crew first'", { skip }, (t) => {
  const env = sandbox(t, "0.8.5");
  const r = gardenPairing({ productIds: ["wicked-vault", "wicked-garden"], dryRun: false, env, platform: "linux", published: () => GARDEN_1602 });
  assert.equal(r.action, "refused");
  assert.match(r.message, /core-ts 0\.8\.5, but wicked-garden 12\.69\.1 needs core-ts 0\.9\.0 or newer/);
  assert.match(r.message, /upgrade wicked-crew first/);
  const { r: refused, out } = quiet(() => pairingRefused(["wicked-garden"], { dryRun: false }, () => r));
  assert.equal(refused, true);
  assert.match(out, /upgrade wicked-crew first/);
});

test("a current crew pairs; crew in the same install is not judged; no crew is not judged; garden absent is not judged", { skip }, (t) => {
  const never = () => assert.fail("not asked");
  assert.equal(gardenPairing({ productIds: ["wicked-garden"], dryRun: false, env: sandbox(t, "0.16.0"), platform: "linux", published: () => GARDEN_1602 }).action, "ok");
  assert.equal(gardenPairing({ productIds: ["wicked-garden", "wicked-crew"], dryRun: false, env: sandbox(t, "0.8.5"), platform: "linux", published: never }).action, "ok");
  assert.equal(gardenPairing({ productIds: ["wicked-garden"], dryRun: false, env: { PATH: "/nonexistent", HOME: "/nonexistent" }, platform: "linux", published: never }).action, "ok");
  assert.equal(gardenPairing({ productIds: ["wicked-bus"], dryRun: false, env: sandbox(t, "0.8.5"), platform: "linux", published: never }).action, "ok");
});

test("core-ts beside crew in the global node_modules is read too", { skip }, (t) => {
  assert.equal(installedCoreTs(sandbox(t, "0.8.5", { beside: true }), "linux"), "0.8.5");
});

test("a published garden from 12.69.0 without the field carries floor 0.9.0; an older fieldless garden has none", () => {
  assert.equal(gardenCoreFloor(GARDEN_1602), "0.9.0");
  assert.equal(gardenCoreFloor({ version: "12.69.0" }), "0.9.0");
  assert.equal(gardenCoreFloor({ version: "12.68.7" }), undefined);
  assert.equal(gardenCoreFloor({ version: "12.70.0", wicked: { coreTsFloor: "0.12.0" } }), "0.12.0");
});

test("dry-run spawns nothing (no npm view) and says what it would check; an unreadable registry is a note", { skip }, (t) => {
  const env = sandbox(t, "0.8.5");
  const dry = gardenPairing({ productIds: ["wicked-garden"], dryRun: true, env, platform: "linux", published: () => assert.fail("dry-run") });
  assert.equal(dry.action, "planned");
  assert.match(dry.message, /core-ts 0\.8\.5/);
  const off = gardenPairing({ productIds: ["wicked-garden"], dryRun: false, env, platform: "linux", published: () => undefined });
  assert.equal(off.action, "noted");
});

test("the real npm seam: a fieldless garden's `npm view` prints a bare version string, and the gate still refuses", { skip }, (t) => {
  const env = sandbox(t, "0.8.5");
  const log = join(env.HOME, "..", "npm.log");
  // npm unwraps a single present field: `npm view wicked-garden@latest version wicked --json` -> "12.69.0".
  writeFileSync(join(env.PATH, "npm"), `#!/bin/sh\necho "$*" >> '${log}'\necho '"12.69.0"'\n`, { mode: 0o755 });
  const r = gardenPairing({ productIds: ["wicked-garden"], dryRun: false, env, platform: "linux" });
  assert.equal(r.action, "refused", r.message);
  assert.match(r.message, /wicked-garden 12\.69\.0 needs core-ts 0\.9\.0/);
  assert.equal(readFileSync(log, "utf8").trim(), "view wicked-garden@latest version wicked --json --fetch-retries=0");
});

test("--source-root: the checkout's own manifest decides, and npm is never asked", { skip }, (t) => {
  const env = sandbox(t, "0.8.5");
  const src = join(env.HOME, "..", "src");
  mkdirSync(join(src, "wicked-garden"), { recursive: true });
  const never = () => assert.fail("npm not asked for a local garden");
  writeFileSync(join(src, "wicked-garden", "package.json"), JSON.stringify({ name: "wicked-garden", version: "12.68.7" }));
  assert.equal(gardenPairing({ productIds: ["wicked-garden"], dryRun: false, sourceRoot: src, env, platform: "linux", published: never }).action, "ok", "a pre-retirement checkout pairs with an old crew");
  writeFileSync(join(src, "wicked-garden", "package.json"), JSON.stringify({ name: "wicked-garden", version: "12.70.0", wicked: { coreTsFloor: "0.9.0" } }));
  const r = gardenPairing({ productIds: ["wicked-garden"], dryRun: false, sourceRoot: src, env, platform: "linux", published: never });
  assert.equal(r.action, "refused");
  assert.match(r.message, /upgrade wicked-crew first/);
});
