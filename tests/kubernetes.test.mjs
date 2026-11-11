// kubernetes.test.mjs — the local-Kubernetes need and crew's cluster install (k8s runner). Every case uses a
// fake spawn and fake executables in a throwaway dir: no real kubectl or cluster is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkKubernetes, ensureClusterForCrew, pickContext, PODS_PIDS_MAX } = await import("../dist/kubernetes.js");

const skip = process.platform === "win32" ? "fake executables are POSIX files" : false;

function sandbox(t) {
  const tmp = mkdtempSync(join(tmpdir(), "wi-k8s-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const exe = (name) => { const p = join(tmp, name); writeFileSync(p, "#!/bin/sh\nexit 0\n"); chmodSync(p, 0o755); return p; };
  return { tmp, exe, env: { PATH: tmp, HOME: tmp, WICKED_CORE_EXE: join(tmp, "wicked-core") } };
}

/** A fake cluster: answers per `world`; records every call. */
function fakeSpawn(world) {
  const calls = [];
  const spawn = (bin, args) => {
    calls.push([bin.split("/").pop(), ...args]);
    const a = args.join(" ");
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    const no = (stderr) => ({ status: 1, stdout: "", stderr });
    if (bin.endsWith("kubectl")) {
      if (a === "config get-contexts -o name") return ok((world.contexts ?? ["rancher-desktop"]).join("\n") + "\n");
      if (a.includes(" version ")) return world.down ? no("The connection to the server 127.0.0.1:6443 was refused") : ok("{}");
      if (a.includes("get nodes")) return ok("lima-rancher-desktop");
      if (a.includes("/proxy/configz")) return ok(JSON.stringify({ kubeletconfig: world.pids === undefined ? {} : { podPidsLimit: world.pids } }));
    }
    if (bin.endsWith("wicked-core")) {
      if (args[0] === "cluster" && args[1] === "status") return { status: world.installed ? 0 : 1, stdout: JSON.stringify(world.installed ? { configured: true, reachable: true, controller: { ready: world.controller !== false } } : { configured: false, reachable: false, kind: "no_cluster" }), stderr: "" };
      if (args[0] === "cluster" && args[1] === "install") return world.installRefuses ? no("pids_unlimited: the probe pod forked past 4096") : ok("{\"installed\":true}");
    }
    return no(`unexpected: ${bin} ${a}`);
  };
  return { spawn, calls };
}

const ctxOf = (sb, world, probeOnly = false) => ({ env: sb.env, platform: "linux", probeOnly, ...fakeSpawn(world) });

test("no kubectl: unmet, with the desktop apps as the fix", { skip }, (t) => {
  const sb = sandbox(t);
  const r = checkKubernetes(ctxOf(sb, {}));
  assert.equal(r.met, false);
  assert.match(r.remedy, /Rancher Desktop/);
});

test("--dry-run spawns nothing: kubectl found reads met but unverified", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl");
  const c = ctxOf(sb, {}, true);
  const r = checkKubernetes(c);
  assert.deepEqual([r.met, r.verified], [true, false]);
  assert.equal(c.calls.length, 0);
});

test("only a local context, never the current one; an operator-named one must exist", () => {
  assert.equal(pickContext(["prod-eks", "docker-desktop", "rancher-desktop"], {}), "rancher-desktop");
  assert.equal(pickContext(["prod-eks", "docker-desktop"], {}), "docker-desktop");
  assert.equal(pickContext(["prod-eks"], {}), null);
  assert.equal(pickContext(["prod-eks", "kind-dev"], { WICKED_K8S_ADMIN_CONTEXT: "kind-dev" }), "kind-dev");
  assert.equal(pickContext(["prod-eks"], { WICKED_K8S_ADMIN_CONTEXT: "kind-dev" }), null);
});

test("a cluster that does not answer, or sets no pod process limit, is unmet with its own fix", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  assert.match(checkKubernetes(ctxOf(sb, { down: true })).detail, /does not answer/);
  assert.match(checkKubernetes(ctxOf(sb, { contexts: ["prod-eks"] })).detail, /no local context/);
  for (const pids of [undefined, -1, 0, PODS_PIDS_MAX + 1]) {
    const r = checkKubernetes(ctxOf(sb, { pids }));
    assert.equal(r.met, false, String(pids));
    assert.match(r.remedy, /pod-max-pids=4096/);
  }
});

test("a ready cluster without crew's part says the exact install command, home spelled ~", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  const r = checkKubernetes(ctxOf(sb, { pids: 4096 }));
  assert.equal(r.met, false);
  assert.match(r.remedy, /wicked-core cluster install --admin-context rancher-desktop --home ~\/\.wicked-crew/);
  assert.doesNotMatch(r.remedy, new RegExp(sb.tmp));
  const ok = checkKubernetes(ctxOf(sb, { pids: 4096, installed: true }));
  assert.equal(ok.met, true, ok.detail);
  assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, installed: true, controller: false })).met, false);
});

test("ensureClusterForCrew installs crew's part only when the cluster can hold seats", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  const run = (world, dryRun = false) => { const f = fakeSpawn(world); return { r: ensureClusterForCrew({ productIds: ["wicked-crew"], dryRun, env: sb.env, platform: "linux", spawn: f.spawn }), calls: f.calls }; };
  const installs = (calls) => calls.filter((c) => c[1] === "cluster" && c[2] === "install");

  const fresh = run({ pids: 4096 });
  assert.equal(fresh.r.action, "installed", fresh.r.message);
  assert.deepEqual(installs(fresh.calls), [["wicked-core", "cluster", "install", "--admin-context", "rancher-desktop", "--home", join(sb.tmp, ".wicked-crew")]]);

  // A cluster setting (no pod process limit) or a stopped cluster is the operator's: nothing is installed.
  for (const world of [{ pids: -1 }, { down: true }]) {
    const x = run(world);
    assert.equal(x.r.action, "skipped"); assert.equal(installs(x.calls).length, 0);
  }
  assert.equal(run({ pids: 4096, installed: true }).r.action, "already");
  const refused = run({ pids: 4096, installRefuses: true });
  assert.equal(refused.r.action, "failed"); assert.match(refused.r.message, /pids_unlimited/);
  const dry = run({ pids: 4096 }, true);
  assert.equal(dry.r.action, "skipped"); assert.equal(dry.calls.length, 0);
  assert.equal(ensureClusterForCrew({ productIds: ["wicked-garden"], dryRun: false, env: sb.env, platform: "linux", spawn: () => { throw new Error("no"); } }).action, "not-needed");
});
