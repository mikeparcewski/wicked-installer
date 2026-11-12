// kubernetes.test.mjs — the local-Kubernetes need and crew's cluster install (k8s runner). Every case uses a
// stateful fake spawn and fake executables in a throwaway dir: no real kubectl or cluster is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { RANCHER_CONTAINERD_WARNING, checkKubernetes, ensureClusterForCrew, findKubectl, pickContext, isLocalServer, publicDiagnostic, shellWord, installCommand, findWickedCore, PODS_PIDS_MAX } = await import("../dist/kubernetes.js");

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
    calls.push({ bin, argv: [bin.split("/").pop(), ...args], env: opts.env, timeoutMs: opts.timeoutMs });
    const a = args.join(" ");
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    const no = (stderr) => ({ status: 1, stdout: "", stderr });
    if (bin.endsWith("docker")) {
      if (world.dockerFails) return no("docker config unreadable");
      if (a === "context show") return ok(world.dockerContext ?? "default");
      if (args[0] === "context" && args[1] === "inspect") return ok(world.dockerEndpoint ?? "unix:///var/run/docker.sock");
      if (a === "context ls --format {{.Name}}") return ok((world.dockerContexts ?? ["default", "rancher-desktop"]).join("\n"));
    }
    if (bin.endsWith("kubectl")) {
      if (a.endsWith("config get-contexts -o name")) return world.configBroken ? no("error loading config file: yaml: line 3") : ok((world.contexts ?? ["rancher-desktop"]).join("\n") + "\n");
      if (a.includes("config view --minify")) return ok(`${world.server ?? "https://127.0.0.1:6443"} ${world.proxy ?? ""}`.trim());
      if (a.includes(" version ")) return world.down ? no("The connection to the server 127.0.0.1:6443 was refused") : ok("{}");
      if (a.includes("containerRuntimeVersion")) return world.runtimeUnread ? no("forbidden") : ok(world.runtime ?? "docker://29.5.3");
      if (a.includes("get nodes")) return ok((world.nodes ?? ["lima-rancher-desktop"]).join(" "));
      if (a.includes("/proxy/configz")) return ok(JSON.stringify({ kubeletconfig: world.pids === undefined ? {} : { podPidsLimit: world.pids } }));
    }
    if (bin.endsWith("wicked-core")) {
      if (args[0] === "cluster" && args[1] === "status") {
        if (world.status !== undefined) return { status: world.statusExit ?? 1, stdout: world.status, stderr: "" };
        return { status: world.installed ? 0 : 1, stdout: JSON.stringify(world.installed ? { configured: true, reachable: true, controller: { ready: world.controller !== false } } : { configured: false, reachable: false, kind: "no_cluster" }), stderr: "" };
      }
      if (args[0] === "cluster" && args[1] === "install") return world.installStderr !== undefined ? no(world.installStderr) : world.installRefuses ? no(`pids_unlimited: probe failed; token=supersecret at ${world.home}/.wicked-crew/k8s`) : ok("{\"installed\":true}");
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

test("Rancher Desktop on containerd: the installer warns before the cluster install, read-only (wicked-core#1449)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  const run = (world) => {
    const f = fakeSpawn({ home: sb.tmp, ...world }); const order = [];
    const spawn = (bin, args, opts) => { order.push(args.includes("install") ? "install" : "spawn"); return f.spawn(bin, args, opts); };
    const r = ensureClusterForCrew({ productIds: ["wicked-crew"], dryRun: false, env: sb.env, platform: "linux", spawn, warn: (l) => order.push(`warn:${l}`) });
    return { r, order, calls: f.calls };
  };
  const c = run({ pids: 4096, runtime: "containerd://1.7.27" });
  const warns = c.order.filter((x) => x.startsWith("warn:"));
  assert.deepEqual(warns, [`warn:${RANCHER_CONTAINERD_WARNING}`]);
  assert.ok(c.order.indexOf(warns[0]) < c.order.indexOf("install"), "warned before the install");
  assert.match(RANCHER_CONTAINERD_WARNING, /dockerd \(moby\).*Preferences → Container Engine.*wicked-core#1449/);
  assert.equal(c.r.action, "installed");
  // read-only: the engine read is a kubectl get, nothing else touches the desktop's settings
  assert.ok(c.calls.filter((x) => x.argv.includes("containerRuntimeVersion") || x.argv.some((a) => a.includes("containerRuntimeVersion"))).every((x) => x.argv[0] === "kubectl" && x.argv.includes("get")));
  // dockerd, an unreadable node, another context: no warning
  for (const world of [{ pids: 4096 }, { pids: 4096, runtimeUnread: true }, { pids: 4096, contexts: ["docker-desktop"], runtime: "containerd://1.7.27" }]) {
    assert.equal(run(world).order.filter((x) => x.startsWith("warn:")).length, 0, JSON.stringify(world));
  }
});

test("diagnostics and pasted words are safe to print", () => {
  const env = { HOME: "/home/alice" };
  const foreign = ["", "Users", "carol", "x"].join("/");
  const s = publicDiagnostic(`Unauthorized: Authorization: Bearer abc.def.ghi token=hunter2 https://bob:pw@reg.local/v2 at /home/alice/.kube and ${foreign}\u001b[31m\nsecond`, env, "linux");
  for (const leak of ["abc.def.ghi", "hunter2", "bob:pw", "alice", "carol", "\u001b", "second"]) assert.ok(!s.includes(leak), `${leak} in ${s}`);
  assert.equal(publicDiagnostic("api key: TOPSECRET1234", env, "linux"), "api key: [redacted]");
  assert.equal(shellWord("rancher-desktop", "linux"), "rancher-desktop");
  assert.equal(shellWord("my ctx;rm -rf", "linux"), "'my ctx;rm -rf'");
  assert.equal(shellWord("it's", "linux"), `'it'\\''s'`);
  assert.equal(publicDiagnostic("first line\nsecond line", env, "linux"), "first line");
  assert.equal(publicDiagnostic("x".repeat(300), env, "linux"), "x".repeat(239) + "…");
});

test("installCommand preserves paths outside this HOME and quotes spaces (#63)", () => {
  const env = { HOME: "/home/alice" };
  const target = { kubectl: "/usr/bin/kubectl", context: "rancher-desktop", kubeconfig: "/home/bob/.kube/config" };
  const command = (kubeconfig) => installCommand("/home/bob/bin/wicked-core", { ...target, kubeconfig }, env, "linux");
  assert.equal(command(target.kubeconfig), "/home/bob/bin/wicked-core cluster install --admin-context rancher-desktop --admin-kubeconfig /home/bob/.kube/config --home ~/.wicked-crew");
  assert.match(command("/home/alice/.kube/config"), /--admin-kubeconfig ~\/\.kube\/config/);
  assert.match(command("/home/bob/kube configs/config"), /--admin-kubeconfig '\/home\/bob\/kube configs\/config'/);
  assert.match(command("/srv/kube/config"), /--admin-kubeconfig \/srv\/kube\/config/);
  assert.match(installCommand("/home/alice/bin/wicked-core", target, env, "linux"), /^~\/bin\/wicked-core /);
});

test("not_installed remedy keeps a kubeconfig outside HOME pasteable (#63)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  const kubeconfig = "/home/bob/.kube/config";
  // Fake only the synthetic file's existence; kubectl still reads through the injected spawn.
  const exists = fs.existsSync;
  const mocked = t.mock.method(fs, "existsSync", (p) => p === kubeconfig || exists(p));
  syncBuiltinESMExports();
  const env = { ...sb.env, HOME: "/home/alice", KUBECONFIG: kubeconfig };
  try {
    const r = checkKubernetes({ ...ctxOf(sb, { pids: 4096 }), env });
    assert.equal(r.state, "not_installed");
    assert.ok(r.remedy.includes(`--admin-kubeconfig ${kubeconfig}`), r.remedy);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

const RUNTIME_DOWN = "wicked-core cluster install: an image builder is required: container_runtime_down: a container runtime CLI is installed but its engine did not answer (`<runtime> version` failed) — start it (Docker Desktop, Rancher Desktop, `podman machine start`, `colima start`) and retry";

function runtimeRefusal(sb, world = {}, platform = "darwin") {
  const f = fakeSpawn({ home: sb.tmp, pids: 4096, installStderr: RUNTIME_DOWN, ...world });
  return { r: ensureClusterForCrew({ productIds: ["wicked-crew"], dryRun: false, env: sb.env, platform, spawn: f.spawn }), calls: f.calls };
}

test("long one-line runtime refusal retains the full remedy and redacts a token (#62)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  // Host Docker installations must not affect this no-CLI case.
  const stat = fs.statSync;
  const mocked = t.mock.method(fs, "statSync", (p, ...args) => {
    if (p === "/usr/local/bin/docker" || p === "/opt/homebrew/bin/docker" || p === "/Applications/Docker.app/Contents/Resources/bin/docker") throw new Error("not installed");
    return stat(p, ...args);
  });
  syncBuiltinESMExports();
  try {
    const stderr = RUNTIME_DOWN.replace(" and retry", " token=supersecret and retry");
    assert.ok(stderr.length > 240);
    const { r, calls } = runtimeRefusal(sb, { installStderr: stderr });
    assert.equal(r.action, "failed");
    assert.equal(r.message, `wicked-core cluster install refused the rancher-desktop cluster: ${RUNTIME_DOWN.replace(" and retry", " token=[redacted] and retry")}`);
    assert.match(r.message, /and retry$/);
    assert.doesNotMatch(r.message, /supersecret|…/);
    assert.equal(calls.filter((c) => c.argv[0] === "docker").length, 0);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("Rancher Desktop runtime refusal names the docker CLI, context and endpoint, with a context-use remedy (#62)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); const docker = sb.exe("docker");
  sb.exe("docker", join(sb.tmp, ".rd", "bin"));
  const { r, calls } = runtimeRefusal(sb);
  assert.match(r.message, /Rancher Desktop's Kubernetes answers/);
  assert.match(r.message, /~\/docker/);
  assert.match(r.message, /`default` \(unix:\/\/\/var\/run\/docker.sock\)/);
  assert.ok(r.message.includes("\nRun: `~/docker context use rancher-desktop`, then run the installer again."), r.message);
  const probes = calls.filter((c) => c.argv[0] === "docker");
  assert.deepEqual(probes.map((c) => c.argv.slice(1)), [["context", "show"], ["context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}"], ["context", "ls", "--format", "{{.Name}}"]]);
  assert.ok(probes.every((c) => c.bin === docker && c.timeoutMs > 0 && c.timeoutMs <= 5000 && c.env.PATH === sb.env.PATH));
  assert.match(r.message, /and retry/); assert.doesNotMatch(r.message, /…/);
});

test("Rancher Desktop missing docker context gets a literal $HOME socket remedy, read-only (#62)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); const docker = sb.exe("docker", join(sb.tmp, "home with spaces", ".rd", "bin"));
  sb.env.HOME = join(sb.tmp, "home with spaces"); sb.env.KUBECONFIG = join(sb.tmp, ".kube", "config");
  writeFileSync(join(sb.env.HOME, ".rd", "docker.sock"), "");
  const { r, calls } = runtimeRefusal(sb, { dockerContexts: ["default"] });
  assert.match(r.message, /~\/\.rd\/bin\/docker/);
  assert.ok(r.message.includes('\nRun: `~/.rd/bin/docker context create rancher-desktop --docker "host=unix://$HOME/.rd/docker.sock" && ~/.rd/bin/docker context use rancher-desktop`, then run the installer again.'), r.message);
  assert.ok(!r.message.includes(sb.tmp), r.message);
  assert.ok(calls.filter((c) => c.argv[0] === "docker").every((c) => c.bin === docker));
  assert.ok(calls.filter((c) => c.argv[0] === "docker").every((c) => !c.argv.includes("create") && !c.argv.includes("use")));
});

test("on-PATH docker context creation uses the resolved executable and a quoted literal HOME socket (review 3)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker");
  mkdirSync(join(sb.tmp, ".rd")); writeFileSync(join(sb.tmp, ".rd", "docker.sock"), "");
  const { r } = runtimeRefusal(sb, { dockerContexts: ["default"] });
  assert.ok(r.message.includes('\nRun: `~/docker context create rancher-desktop --docker "host=unix://$HOME/.rd/docker.sock" && ~/docker context use rancher-desktop`, then run the installer again.'), r.message);
});

for (const runtime of ["podman", "/home/alice/bin/podman"]) test(`chosen non-docker runtime ${runtime} skips Docker diagnosis (review 1)`, { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker");
  sb.env.WICKED_CONTAINER_RUNTIME = runtime;
  const { r, calls } = runtimeRefusal(sb);
  assert.equal(r.action, "failed");
  assert.match(r.message, /`colima start`\) and retry/);
  assert.equal(calls.filter((c) => c.argv[0] === "docker").length, 0);
  assert.ok(r.message.includes(`WICKED_CONTAINER_RUNTIME chose ${runtime.replace("/home/alice", "~")}; its engine did not answer. Retry: `), r.message);
  assert.match(r.message, /wicked-core cluster install/);
  assert.doesNotMatch(r.message, /docker CLI|context use|\/home\/alice/);
});

test("chosen absolute docker is diagnosed instead of PATH docker (review 1 and 3)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker");
  const docker = sb.exe("docker", join(sb.tmp, "chosen runtime")); sb.env.WICKED_CONTAINER_RUNTIME = docker;
  const { r, calls } = runtimeRefusal(sb);
  assert.ok(calls.filter((c) => c.argv[0] === "docker").every((c) => c.bin === docker));
  assert.ok(r.message.includes("Run: `~/'chosen runtime/docker' context use rancher-desktop`"), r.message);
});

test("chosen relative docker path resolves against PATH for probes and the remedy", { skip }, (t) => {
  const sb = sandbox(t); const bin = join(sb.tmp, "bin");
  sb.exe("kubectl", bin); sb.exe("wicked-core");
  const docker = sb.exe("docker", join(bin, "tools"));
  sb.env.PATH = bin; sb.env.WICKED_CONTAINER_RUNTIME = "tools/docker";
  const { r, calls } = runtimeRefusal(sb);
  const probes = calls.filter((c) => c.argv[0] === "docker");
  assert.equal(probes.length, 3);
  assert.ok(probes.every((c) => c.bin === docker));
  assert.ok(r.message.includes("Run: `~/bin/tools/docker context use rancher-desktop`"), r.message);
});

test("chosen bare docker resolves on PATH and blank runtime keeps discovery (review 1)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); const docker = sb.exe("docker");
  for (const runtime of ["docker", "  "]) {
    sb.env.WICKED_CONTAINER_RUNTIME = runtime;
    const { r, calls } = runtimeRefusal(sb);
    assert.ok(r.message.includes("Run: `~/docker context use rancher-desktop`"), r.message);
    assert.equal(calls.filter((c) => c.argv[0] === "docker").length, 3);
    assert.ok(calls.filter((c) => c.argv[0] === "docker").every((c) => c.bin === docker));
  }
  rmSync(docker); sb.exe("docker", join(sb.tmp, ".rd", "bin")); sb.env.WICKED_CONTAINER_RUNTIME = "docker";
  const { r, calls } = runtimeRefusal(sb);
  assert.equal(calls.filter((c) => c.argv[0] === "docker").length, 0);
  assert.doesNotMatch(r.message, /docker CLI|context use/);
});

for (const [overrides, prefix] of [
  [{ DOCKER_HOST: "tcp://PRIVATE_ENGINE:2375" }, "unset DOCKER_HOST && "],
  [{ DOCKER_CONTEXT: "other-context" }, "unset DOCKER_CONTEXT && "],
  [{ DOCKER_HOST: "tcp://PRIVATE_ENGINE:2375", DOCKER_CONTEXT: "other-context" }, "unset DOCKER_HOST && unset DOCKER_CONTEXT && "],
  [{ DOCKER_HOST: "tcp://PRIVATE_ENGINE:2375", DOCKER_CONTEXT: "rancher-desktop" }, "unset DOCKER_HOST && "],
]) test(`Docker env overrides ${Object.entries(overrides).map(([k, v]) => k + (k === "DOCKER_CONTEXT" ? "=" + v : "")).join(" and ")} get unset remedies (review 2)`, { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker"); Object.assign(sb.env, overrides);
  const { r, calls } = runtimeRefusal(sb, { dockerContext: overrides.DOCKER_CONTEXT ?? "rancher-desktop", dockerEndpoint: overrides.DOCKER_HOST, installStderr: RUNTIME_DOWN + (overrides.DOCKER_HOST ? ` Failed endpoint ${overrides.DOCKER_HOST}` : "") });
  for (const name of Object.keys(overrides)) assert.ok(r.message.includes(`${name} overrides`), r.message);
  assert.ok(r.message.includes(`Run: \`${prefix}~/docker context use rancher-desktop\`, then run the installer again in the same shell.`), r.message);
  assert.doesNotMatch(r.message, /PRIVATE_ENGINE|unset DOCKER_CONTEXT &&.*unset DOCKER_CONTEXT/);
  const retry = runtimeRefusal(sb, { dockerFails: true }).r.message;
  assert.ok(retry.includes("Run: `~/wicked-core cluster install "), retry);
  assert.doesNotMatch(retry, /unset|in the same shell/);
  for (const call of calls.filter((c) => c.argv[0] === "docker" || c.argv.includes("install")))
    for (const [name, value] of Object.entries(overrides)) assert.equal(call.env[name], value);
});

test("Docker Desktop retry explains DOCKER_CONTEXT without unsetting it", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker");
  sb.env.DOCKER_CONTEXT = "desktop-linux";
  const { r } = runtimeRefusal(sb, { contexts: ["docker-desktop"], dockerContext: "desktop-linux" });
  assert.equal(r.action, "failed");
  assert.match(r.message, /DOCKER_CONTEXT overrides/);
  assert.doesNotMatch(r.message, /unset|in the same shell/);
  assert.ok(r.message.includes("\nRun: `~/wicked-core cluster install --admin-context docker-desktop "), r.message);
});

test("DOCKER_CONTEXT=rancher-desktop explains the override without unsetting it (review 2)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker"); sb.env.DOCKER_CONTEXT = "rancher-desktop";
  const { r } = runtimeRefusal(sb, { dockerContext: "rancher-desktop" });
  assert.match(r.message, /DOCKER_CONTEXT overrides/);
  assert.doesNotMatch(r.message, /unset DOCKER_CONTEXT|context use/);
  assert.match(r.message, /Run: `~\/wicked-core cluster install/);
});

test("Docker.app CLI is the final Docker fallback (review 4)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core");
  const docker = "/Applications/Docker.app/Contents/Resources/bin/docker";
  const stat = fs.statSync, access = fs.accessSync;
  const mockedStat = t.mock.method(fs, "statSync", (p, ...args) => {
    if (p === docker) return { isFile: () => true };
    if (p === "/usr/local/bin/docker" || p === "/opt/homebrew/bin/docker") throw new Error("not installed");
    return stat(p, ...args);
  });
  const mockedAccess = t.mock.method(fs, "accessSync", (p, ...args) => p === docker ? undefined : access(p, ...args));
  syncBuiltinESMExports();
  try {
    const { r, calls } = runtimeRefusal(sb);
    assert.equal(calls.filter((c) => c.bin === docker).length, 3);
    assert.ok(r.message.includes(`Run: \`${docker} context use rancher-desktop\``), r.message);
    // An earlier desktop candidate still wins.
    const rd = sb.exe("docker", join(sb.tmp, ".rd", "bin"));
    assert.ok(runtimeRefusal(sb).calls.filter((c) => c.argv[0] === "docker").every((c) => c.bin === rd));
  } finally { mockedStat.mock.restore(); mockedAccess.mock.restore(); syncBuiltinESMExports(); }
});

test("other runtime refusals retain the engine remedy and a pasteable retry; docker read failures are tolerated (#62)", { skip }, (t) => {
  const sb = sandbox(t); sb.exe("kubectl"); sb.exe("wicked-core"); sb.exe("docker");
  for (const world of [{ contexts: ["docker-desktop"] }, { dockerContext: "rancher-desktop", dockerEndpoint: `unix://${sb.tmp}/.rd/docker.sock` }, { dockerFails: true }]) {
    const { r } = runtimeRefusal(sb, world);
    assert.equal(r.action, "failed");
    assert.match(r.message, /~\/docker/);
    assert.match(r.message, /engine did not answer/);
    assert.match(r.message, /`colima start`\) and retry/);
    assert.match(r.message, /\nRun: `~\/wicked-core cluster install /);
    assert.doesNotMatch(r.message, /…|context use/);
    assert.ok(!r.message.includes(sb.tmp), r.message);
  }
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
