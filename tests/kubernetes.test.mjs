// kubernetes.test.mjs — the local-Kubernetes need and crew's cluster install (k8s runner). Every case uses a
// stateful fake spawn and fake executables in a throwaway dir: no real kubectl or cluster is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkKubernetes, ensureClusterForCrew, findKubectl, pickContext, isLocalServer, publicDiagnostic, shellWord, findWickedCore, PODS_PIDS_MAX } = await import("../dist/kubernetes.js");

const skip = process.platform === "win32" ? "fake executables are POSIX files" : false;

function sandbox(t) {
  const tmp = mkdtempSync(join(tmpdir(), "wi-k8s-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const exe = (name, dir = tmp) => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, "#!/bin/sh\nexit 0\n"); chmodSync(p, 0o755); return p; };
  mkdirSync(join(tmp, ".kube"), { recursive: true });
  writeFileSync(join(tmp, ".kube", "config"), "apiVersion: v1\n");
  return { tmp, exe, env: { PATH: tmp, HOME: tmp, WICKED_CORE_EXE: join(tmp, "wicked-core") } };
}

/** A fake cluster: answers per `world`; records every call with the env it was given. */
function fakeSpawn(world) {
  const calls = [];
  const spawn = (bin, args, opts = {}) => {
    calls.push({ argv: [bin.split("/").pop(), ...args], env: opts.env });
    const a = args.join(" ");
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    const no = (stderr) => ({ status: 1, stdout: "", stderr });
    if (bin.endsWith("kubectl")) {
      if (a.endsWith("config get-contexts -o name")) return world.configBroken ? no("error loading config file: yaml: line 3") : ok((world.contexts ?? ["rancher-desktop"]).join("\n") + "\n");
      if (a.includes("config view --minify")) return ok(`${world.server ?? "https://127.0.0.1:6443"} ${world.proxy ?? ""}`.trim());
      if (a.includes(" version ")) return world.down ? no("The connection to the server 127.0.0.1:6443 was refused") : ok("{}");
      if (a.includes("get nodes")) return ok((world.nodes ?? ["lima-rancher-desktop"]).join(" "));
      if (a.includes("/proxy/configz")) return ok(JSON.stringify({ kubeletconfig: world.pids === undefined ? {} : { podPidsLimit: world.pids } }));
    }
    if (bin.endsWith("wicked-core")) {
      if (args[0] === "cluster" && args[1] === "status") {
        if (world.status !== undefined) return { status: world.statusExit ?? 1, stdout: world.status, stderr: "" };
        return { status: world.installed ? 0 : 1, stdout: JSON.stringify(world.installed ? { configured: true, reachable: true, controller: { ready: world.controller !== false } } : { configured: false, reachable: false, kind: "no_cluster" }), stderr: "" };
      }
      if (args[0] === "cluster" && args[1] === "install") return world.installRefuses ? no(`pids_unlimited: probe failed; token=supersecret at ${world.home}/.wicked-crew/k8s`) : ok("{\"installed\":true}");
    }
    return no(`unexpected: ${bin} ${a}`);
  };
  return { spawn, calls };
}

const ctxOf = (sb, world, probeOnly = false) => ({ env: sb.env, platform: "linux", probeOnly, ...fakeSpawn({ home: sb.tmp, ...world }) });

test("no kubectl: unmet, with the desktop apps as the fix", { skip }, (t) => {
  const sb = sandbox(t);
  const r = checkKubernetes(ctxOf(sb, {}));
  assert.equal(r.met, false); assert.equal(r.state, "no_kubectl");
  assert.match(r.remedy, /Rancher Desktop/);
});

test("--dry-run spawns nothing: kubectl found reads met but unverified, home spelled ~", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl", join(sb.tmp, ".rd", "bin"));
  const c = ctxOf(sb, {}, true);
  const r = checkKubernetes(c);
  assert.deepEqual([r.met, r.verified], [true, false]);
  assert.equal(c.calls.length, 0);
  assert.match(r.detail, /~\/\.rd\/bin\/kubectl/); assert.doesNotMatch(r.detail, new RegExp(sb.tmp));
});

test("only a local context, never the current one; an operator-named one must exist AND be local", { skip }, (t) => {
  assert.equal(pickContext(["prod-eks", "docker-desktop", "rancher-desktop"], {}), "rancher-desktop");
  assert.equal(pickContext(["prod-eks"], {}), null);
  assert.equal(pickContext(["prod-eks", "kind-dev"], { WICKED_K8S_ADMIN_CONTEXT: "kind-dev" }), "kind-dev");
  for (const [u, local] of [["https://127.0.0.1:6443", true], ["https://kubernetes.docker.internal:6443", true], ["https://localhost:6443", true], ["https://prod.eks.amazonaws.com", false], ["https://10.0.0.5:6443", false], ["garbage", false]]) assert.equal(isLocalServer(u), local, u);
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  // A context NAMED docker-desktop that points elsewhere is refused before any cluster call.
  const c = ctxOf(sb, { contexts: ["docker-desktop"], server: "https://prod.example.com:443", pids: 4096 });
  const r = checkKubernetes(c);
  assert.equal(r.state, "not_local");
  assert.ok(c.calls.every((x) => x.argv.includes("config")), JSON.stringify(c.calls.map((x) => x.argv)));
});

test("every probe uses the one pinned kubeconfig and context; the engine gets that kubectl and no KUBECONFIG", { skip }, (t) => {
  const sb = sandbox(t); const kubectl = sb.exe("kubectl"); sb.exe("wicked-core");
  const alt = join(sb.tmp, "alt.yaml"); writeFileSync(alt, "apiVersion: v1\n");
  sb.env.KUBECONFIG = alt;
  const c = ctxOf(sb, { pids: 4096 });
  checkKubernetes(c);
  for (const x of c.calls.filter((x) => x.argv[0] === "kubectl")) assert.equal(x.argv[x.argv.indexOf("--kubeconfig") + 1], alt, x.argv.join(" "));
  const status = c.calls.find((x) => x.argv[0] === "wicked-core");
  assert.equal(status.env.WICKED_KUBECTL, kubectl); assert.equal(status.env.KUBECONFIG, undefined);
});

test("an unreadable kubeconfig is its own state, not 'no local context'", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl");
  const r = checkKubernetes(ctxOf(sb, { configBroken: true }));
  assert.equal(r.state, "config_unreadable");
});

test("a cluster that does not answer, has more than one node, or sets no pod process limit is unmet with its own fix", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  assert.equal(checkKubernetes(ctxOf(sb, { down: true })).state, "unreachable");
  assert.equal(checkKubernetes(ctxOf(sb, { contexts: ["prod-eks"] })).state, "no_local_context");
  assert.equal(checkKubernetes(ctxOf(sb, { nodes: ["a", "b"], pids: 4096 })).state, "topology");
  for (const pids of [undefined, -1, 0, PODS_PIDS_MAX + 1]) {
    const r = checkKubernetes(ctxOf(sb, { pids }));
    assert.equal(r.state, "pids_unlimited", String(pids));
    assert.match(r.remedy, /pod-max-pids=4096/);
  }
});

test("the engine's status decides, validated: not installed, controller down, unread, malformed", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); const core = sb.exe("wicked-core");
  const r = checkKubernetes(ctxOf(sb, { pids: 4096 }));
  assert.equal(r.state, "not_installed");
  // The pasteable command names the resolved binary and every flag, home spelled ~.
  assert.ok(r.remedy.includes("~/wicked-core cluster install --admin-context rancher-desktop --admin-kubeconfig ~/.kube/config --home ~/.wicked-crew"), r.remedy);
  assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, installed: true })).met, true);
  assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, installed: true, controller: false })).state, "controller_not_ready");
  assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, status: JSON.stringify({ configured: true, reachable: true, detail: "is not installed" }) })).state, "engine_unanswered");
  for (const bad of ["{}", "[]", "null", "nope"]) assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, status: bad })).state, "engine_unanswered", bad);
  assert.ok(core);
});

test("ensureClusterForCrew installs crew's part only on a state that says so, on the pinned target", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  const run = (world, dryRun = false) => { const f = fakeSpawn({ home: sb.tmp, ...world }); return { r: ensureClusterForCrew({ productIds: ["wicked-crew"], dryRun, env: sb.env, platform: "linux", spawn: f.spawn }), calls: f.calls }; };
  const installs = (calls) => calls.filter((c) => c.argv[1] === "cluster" && c.argv[2] === "install").map((c) => c.argv);

  const fresh = run({ pids: 4096 });
  assert.equal(fresh.r.action, "installed", fresh.r.message);
  assert.deepEqual(installs(fresh.calls), [["wicked-core", "cluster", "install", "--admin-context", "rancher-desktop", "--admin-kubeconfig", join(sb.tmp, ".kube", "config"), "--home", join(sb.tmp, ".wicked-crew")]]);

  // A cluster setting, a stopped or remote cluster, an unread or malformed status: nothing is installed.
  for (const world of [{ pids: -1 }, { down: true }, { server: "https://prod.example.com", pids: 4096 }, { pids: 4096, status: JSON.stringify({ configured: true, reachable: true, detail: "x is not installed" }) }, { pids: 4096, status: "{}" }]) {
    const x = run(world);
    assert.equal(x.r.action, "skipped", JSON.stringify(world)); assert.equal(installs(x.calls).length, 0);
  }
  assert.equal(run({ pids: 4096, installed: true }).r.action, "already");
  const refused = run({ pids: 4096, installRefuses: true });
  assert.equal(refused.r.action, "failed"); assert.match(refused.r.message, /pids_unlimited/);
  assert.doesNotMatch(refused.r.message, /supersecret/); assert.doesNotMatch(refused.r.message, new RegExp(sb.tmp));
  const dry = run({ pids: 4096 }, true);
  assert.equal(dry.r.action, "skipped"); assert.equal(dry.calls.length, 0);
  assert.equal(ensureClusterForCrew({ productIds: ["wicked-garden"], dryRun: false, env: sb.env, platform: "linux", spawn: () => { throw new Error("no"); } }).action, "not-needed");
});

test("diagnostics and pasted words are safe to print", () => {
  const env = { HOME: "/home/alice" };
  const foreign = ["", "Users", "carol", "x"].join("/");
  const s = publicDiagnostic(`Unauthorized: Authorization: Bearer abc.def.ghi token=hunter2 https://bob:pw@reg.local/v2 at /home/alice/.kube and ${foreign}\u001b[31m\nsecond`, env, "linux");
  for (const leak of ["abc.def.ghi", "hunter2", "bob:pw", "alice", "carol", "\u001b", "second"]) assert.ok(!s.includes(leak), `${leak} in ${s}`);
  assert.equal(shellWord("rancher-desktop", "linux"), "rancher-desktop");
  assert.equal(shellWord("my ctx;rm -rf", "linux"), "'my ctx;rm -rf'");
  assert.equal(shellWord("it's", "linux"), `'it'\\''s'`);
});

test("findWickedCore: the FIRST wicked-crew on PATH decides; a later install is never used", { skip }, (t) => {
  const sb = sandbox(t);
  const mk = (prefix, withCore) => {
    const pkg = join(sb.tmp, prefix, "lib", "node_modules", "wicked-crew");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "wicked-crew" }));
    const bin = sb.exe("wicked-crew", join(pkg, "bin"));
    const dir = join(sb.tmp, prefix, "bin"); mkdirSync(dir, { recursive: true });
    return { dir, bin, pkg, withCore: withCore ? sb.exe("wicked-core", join(pkg, "node_modules", "wicked-core-ts-linux-x64-gnu")) : null };
  };
  const a = mk("a", false), b = mk("b", true);
  for (const x of [a, b]) symlinkSync(x.bin, join(x.dir, "wicked-crew"));
  const env = { PATH: [a.dir, b.dir].join(":"), HOME: sb.tmp };
  assert.equal(findWickedCore(env, "linux", "x64"), null, "the first crew has no bundled engine: never fall through to the second");
  assert.equal(findWickedCore({ ...env, PATH: b.dir }, "linux", "x64"), realpathSync(b.withCore));
});


test("codex r2 folds: a remote proxy, a merged KUBECONFIG, an exit that contradicts its document", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  assert.equal(checkKubernetes(ctxOf(sb, { proxy: "http://proxy.corp:3128", pids: 4096 })).state, "not_local");
  const two = { ...sb.env, KUBECONFIG: [join(sb.tmp, "a"), join(sb.tmp, "b")].join(":") };
  assert.equal(checkKubernetes({ ...ctxOf(sb, { pids: 4096 }), env: two }).state, "config_unreadable");
  // "not configured" printed with exit 0, or "installed" printed by a failed process: never trusted.
  assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, status: JSON.stringify({ configured: false, reachable: false }), statusExit: 0 })).state, "engine_unanswered");
  assert.equal(checkKubernetes(ctxOf(sb, { pids: 4096, status: JSON.stringify({ configured: true, reachable: true, controller: { ready: true } }), statusExit: 1 })).state, "engine_unanswered");
});

test("codex r2 folds: prefixed tokens, password-less userinfo, sanitized names, ~ outside quotes, bare WICKED_KUBECTL", { skip }, (t) => {
  const env = { HOME: "/home/alice" };
  const s = publicDiagnostic("access_token=aaa refresh_token: bbb id_token=ccc https://hunter2@example.test/x", env, "linux");
  for (const leak of ["aaa", "bbb", "ccc", "hunter2"]) assert.ok(!s.includes(leak), `${leak} in ${s}`);
  assert.equal(shellWord("~/Library/Application Support/core", "linux"), "~/'Library/Application Support/core'");
  const sb = sandbox(t); const kubectl = sb.exe("kubectl", join(sb.tmp, "bin2"));
  assert.equal(findKubectl({ PATH: join(sb.tmp, "bin2"), HOME: sb.tmp, WICKED_KUBECTL: "kubectl" }, "linux"), kubectl);
  assert.equal(findKubectl({ PATH: sb.tmp, HOME: sb.tmp, WICKED_KUBECTL: "kubectl" }, "linux"), null);
});
