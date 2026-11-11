/**
 * The local Kubernetes cluster wicked-crew's governed seats run on (the k8s runner, wicked-core
 * k8s-swap). Two halves:
 *
 * - {@link checkKubernetes}: the readiness need (`kind: "kubernetes"`), read-only. It resolves ONE
 *   target (kubectl, the kubeconfig file, a context whose API server is on this machine) and makes
 *   every observation through it: the cluster answers, it has the single node the engine supports,
 *   that node's kubelet limits each pod's processes (`podPidsLimit` 1..4096, from the node's
 *   `configz`), and the engine's own `wicked-core cluster status` says crew's part is installed and
 *   its sandbox controller is ready.
 * - {@link ensureClusterForCrew}: after crew is installed, `wicked-core cluster install
 *   --admin-context <ctx> --admin-kubeconfig <file> --home <crew's state home>` on THAT target, and
 *   only when the engine reported crew's part missing (or its controller not ready). The engine's
 *   install is what proves the cluster can hold seats: it forks past the pod process limit in a
 *   probe pod and checks a NetworkPolicy deny holds, and refuses (removing what it made) otherwise.
 *
 * The installer never changes the cluster's own settings: a missing `pod-max-pids` or a stopped
 * cluster is the operator's to fix, said with the fix.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Local contexts, in preference order. `WICKED_K8S_ADMIN_CONTEXT` names another (still local) one. */
export const LOCAL_CONTEXTS = ["rancher-desktop", "docker-desktop"] as const;
/** The process limit the engine's seats need (wicked-core `FloorUnarmed::PidsUnlimited`). */
export const PODS_PIDS_MAX = 4096;
/** API server hosts that are this machine (Rancher Desktop: 127.0.0.1; Docker Desktop: kubernetes.docker.internal). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "kubernetes.docker.internal"]);
/** The engine's install can apply manifests, roll out the controller, build the floor image and probe: minutes. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export type Spawn = (bin: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => { status: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean };

export interface KubeCtx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** PATH probes only: spawn nothing (`--dry-run`). */
  probeOnly: boolean;
  spawn: Spawn;
}

/** What was established, as a decision (a mutation is never decided from prose). */
export type KubeState =
  | "no_kubectl" | "config_unreadable" | "no_local_context" | "not_local" | "unreachable" | "topology"
  | "pids_unreadable" | "pids_unlimited" | "no_engine" | "engine_unanswered"
  | "not_installed" | "controller_not_ready" | "daemon_unreachable" | "ready" | "unchecked";

export interface KubeNeed {
  need: string;
  met: boolean;
  verified?: boolean;
  detail: string;
  remedy?: string;
  state: KubeState;
}

export interface Target {
  kubectl: string;
  kubeconfig: string;
  context: string;
}

const NEED = "local Kubernetes (governed seats run in pods)";
const START = "start Rancher Desktop (Preferences → Kubernetes → Enable) or Docker Desktop (Settings → Kubernetes → Enable)";
const PIDS_FIX =
  `set the kubelet's pod-max-pids to ${PODS_PIDS_MAX}: on Rancher Desktop add \`kubelet-arg: ["pod-max-pids=${PODS_PIDS_MAX}"]\` to /etc/rancher/k3s/config.yaml in the VM ` +
  "(persist it with a provision script in ~/Library/Application Support/rancher-desktop/lima/_config/override.yaml) and restart Kubernetes";

export function defaultSpawn(baseEnv: NodeJS.ProcessEnv): Spawn {
  return (bin, args, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    // A child that ignores SIGTERM must not hang the installer.
    const res = spawnSync(bin, args, { env: opts.env ?? baseEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
    const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const error = res.error ? (timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (res.error as NodeJS.ErrnoException).code ?? "could not run") : undefined;
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ...(error ? { error } : {}), ...(timedOut ? { timedOut } : {}) };
  };
}

function pathOf(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? "";
}

function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
}

function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A path as it may be printed: this user's home spelled `~`. */
export function publicPath(p: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = homeOf(env, platform).replace(/[\\/]+$/, "");
  if (home !== "" && (p === home || p.startsWith(home + "/") || p.startsWith(home + "\\"))) return "~" + p.slice(home.length);
  // Another account's home (or another spelling of one) is never printed as is.
  return p.replace(/^\/(?:private\/)?(?:Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\+Users\\+[^\\]+/, "~");
}

/** An external diagnostic (kubectl, the engine) as it may be printed: one line, no control characters,
 *  credential shapes and URL userinfo redacted, home paths spelled `~`, bounded (sanitized before the cut). */
export function publicDiagnostic(raw: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = homeOf(env, platform).replace(/[\\/]+$/, "");
  let s = (raw.trim().split(/\r?\n/)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  s = s
    .replace(/\b(authorization)\s*[:=]\s*\S+(?:\s+\S+)?/gi, "$1: [redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, "$1 [redacted]")
    .replace(/((?:\b|_)(?:token|password|passwd|secret|api[_-]?key))(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1$2[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]");
  if (home !== "") s = s.split(home).join("~");
  s = s.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~").replace(/[A-Za-z]:\\+Users\\+[^\\\s"'`]+/g, "~");
  return s.length <= 240 ? s : `${s.slice(0, 239)}…`;
}

/** A shell word that pastes safely (POSIX single quotes; PowerShell-style on Windows). */
export function shellWord(s: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9._/~:=@+-]+$/.test(s)) return s;
  const quote = (x: string) => (platform === "win32" ? `'${x.replace(/'/g, "''")}'` : `'${x.replace(/'/g, `'\\''`)}'`);
  // A leading ~/ stays outside the quotes so the shell still expands it.
  return s.startsWith("~/") ? `~/${quote(s.slice(2))}` : quote(s);
}

/** kubectl as the engine resolves it: `WICKED_KUBECTL`, else PATH, else where the desktop apps put it. */
export function findKubectl(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const named = (env.WICKED_KUBECTL ?? "").trim();
  if (named !== "" && /[\\/]/.test(named)) return isExecutable(named, platform) ? named : null;
  const name = named !== "" ? named : platform === "win32" ? "kubectl.exe" : "kubectl";
  for (const dir of pathOf(env).split(delimiter)) if (dir !== "" && isExecutable(join(dir, name), platform)) return join(dir, name);
  if (named !== "") return null;
  const home = homeOf(env, platform);
  const extra = platform === "win32"
    ? [join("C:", "Program Files", "Docker", "Docker", "resources", "bin", name), join(home, ".rd", "bin", name)]
    : [join(home, ".rd", "bin", name), "/Applications/Docker.app/Contents/Resources/bin/kubectl"];
  return extra.find((p) => isExecutable(p, platform)) ?? null;
}

/** crew's state home: `~/.wicked-crew`, crew's default `--db` parent (what `wicked-crew serve` uses). */
export function crewStateHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(homeOf(env, platform), ".wicked-crew");
}

function platformPackage(platform: NodeJS.Platform, arch: string): string | null {
  const abi = platform === "darwin" && arch === "arm64" ? "darwin-arm64"
    : platform === "darwin" && arch === "x64" ? "darwin-x64"
    : platform === "linux" && arch === "x64" ? "linux-x64-gnu"
    : platform === "linux" && arch === "arm64" ? "linux-arm64-gnu"
    : platform === "win32" && arch === "x64" ? "win32-x64-msvc"
    : null;
  return abi === null ? null : `wicked-core-ts-${abi}`;
}

/** The `wicked-core` binary crew runs: `WICKED_CORE_EXE`, else the one bundled with the FIRST
 *  `wicked-crew` on PATH (the one `wicked-crew serve` runs; never another installation's). */
export function findWickedCore(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string = process.arch): string | null {
  const set = (env.WICKED_CORE_EXE ?? "").trim();
  if (set !== "") return isExecutable(set, platform) ? set : null;
  const exe = platform === "win32" ? "wicked-core.exe" : "wicked-core";
  const pkg = platformPackage(platform, arch);
  if (pkg === null) return null;
  const crewBin = platform === "win32" ? "wicked-crew.cmd" : "wicked-crew";
  for (const dir of pathOf(env).split(delimiter)) {
    if (dir === "" || !isExecutable(join(dir, crewBin), platform)) continue;
    // The first launcher decides: its package root, found from the bin's real path (or, for npm's
    // Windows shim, the node_modules beside it).
    const roots: string[] = [];
    try {
      let at = dirname(realpathSync(join(dir, crewBin)));
      for (let i = 0; i < 6; i++, at = dirname(at)) roots.push(at);
    } catch { /* the shim case */ }
    roots.push(join(dir, "node_modules", "wicked-crew"));
    for (const root of roots) {
      try {
        if ((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }).name !== "wicked-crew") continue;
      } catch { continue; }
      return [join(root, "node_modules", pkg, exe), join(dirname(root), pkg, exe)].find((p) => isExecutable(p, platform)) ?? null;
    }
    return null;
  }
  return null;
}

/** The local context to use: the operator's `WICKED_K8S_ADMIN_CONTEXT`, else the first of
 *  {@link LOCAL_CONTEXTS} the kubeconfig defines. Never the current context. */
export function pickContext(contexts: string[], env: NodeJS.ProcessEnv): string | null {
  const named = (env.WICKED_K8S_ADMIN_CONTEXT ?? "").trim();
  if (named !== "") return contexts.includes(named) ? named : null;
  return LOCAL_CONTEXTS.find((c) => contexts.includes(c)) ?? null;
}

/** Whether an API server URL is this machine. */
export function isLocalServer(server: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(server).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function lines(s: string): string[] {
  return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Resolve the one target every observation (and the install) uses. */
export function resolveTarget(ctx: KubeCtx): { target: Target } | { need: KubeNeed } {
  const { env, platform } = ctx;
  const say = (state: KubeState, detail: string, remedy?: string): { need: KubeNeed } => ({ need: { need: NEED, met: false, state, detail, ...(remedy ? { remedy } : {}) } });
  const kubectl = findKubectl(env, platform);
  if (kubectl === null) return say("no_kubectl", "kubectl is not installed, so there is no local Kubernetes for crew's seats", `install Rancher Desktop or Docker Desktop, then ${START}`);
  // The engine runs kubectl without KUBECONFIG and is handed the admin kubeconfig explicitly, so pin one FILE.
  const candidates = (env.KUBECONFIG ?? "").split(delimiter).filter(Boolean);
  // A merged KUBECONFIG list has no single file to hand the engine; the desktop apps write one file.
  if (candidates.length > 1) return say("config_unreadable", "KUBECONFIG lists more than one file; the engine is handed one admin kubeconfig", "point KUBECONFIG at the one file that holds your local cluster (Rancher Desktop and Docker Desktop write ~/.kube/config), then run the installer again");
  if (candidates.length === 0) candidates.push(join(homeOf(env, platform), ".kube", "config"));
  let lastError = "";
  for (const kubeconfig of candidates) {
    if (!existsSync(kubeconfig)) continue;
    const listed = ctx.spawn(kubectl, ["--kubeconfig", kubeconfig, "config", "get-contexts", "-o", "name"]);
    if (listed.status !== 0) { lastError = publicDiagnostic(listed.stderr || listed.error || "no answer", env, platform); continue; }
    const context = pickContext(lines(listed.stdout), env);
    if (context === null) continue;
    const shown = publicDiagnostic(context, env, platform);
    const view = ctx.spawn(kubectl, ["--kubeconfig", kubeconfig, "config", "view", "--minify", "--context", context, "-o", "jsonpath={.clusters[0].cluster.server} {.clusters[0].cluster.proxy-url}"]);
    const [server = "", proxy = ""] = view.stdout.trim().split(/\s+/);
    if (view.status !== 0 || server === "") return say("config_unreadable", `the ${shown} context's API server could not be read (${publicDiagnostic(view.stderr || view.error || "empty", env, platform)})`, "check the kubeconfig, then run the installer again");
    // A local-looking server reached through a proxy is the proxy's cluster, not this machine's.
    if (!isLocalServer(server) || proxy !== "") return say("not_local", `the ${shown} context points at ${publicDiagnostic(proxy !== "" ? `${server} through the proxy ${proxy}` : server, env, platform)}, which is not this machine; crew's seats run only on a local cluster`, `${START}, or point WICKED_K8S_ADMIN_CONTEXT at a local context`);
    return { target: { kubectl, kubeconfig, context } };
  }
  if (lastError !== "") return say("config_unreadable", `the kubeconfig could not be read (${lastError})`, "check the kubeconfig (KUBECONFIG or ~/.kube/config), then run the installer again");
  const named = (env.WICKED_K8S_ADMIN_CONTEXT ?? "").trim();
  return say("no_local_context", named !== "" ? `no kubeconfig defines the context WICKED_K8S_ADMIN_CONTEXT names` : `no kubeconfig defines a local context (${LOCAL_CONTEXTS.join(" or ")}); the current context is never used`, START);
}

/** The single node's kubelet `podPidsLimit` (`/api/v1/nodes/<node>/proxy/configz`). */
function readNode(t: Target, ctx: KubeCtx): { pids: number } | { state: KubeState; detail: string } {
  const k = (args: string[]) => ctx.spawn(t.kubectl, ["--kubeconfig", t.kubeconfig, "--context", t.context, ...args, "--request-timeout=10s"]);
  const nodes = k(["get", "nodes", "-o", "jsonpath={.items[*].metadata.name}"]);
  if (nodes.status !== 0) return { state: "pids_unreadable", detail: `its nodes could not be listed (${publicDiagnostic(nodes.stderr || nodes.error || "no answer", ctx.env, ctx.platform)})` };
  const names = nodes.stdout.trim().split(/\s+/).filter(Boolean);
  if (names.length !== 1 || !/^[a-z0-9.-]{1,253}$/.test(names[0] as string)) return { state: "topology", detail: `it has ${names.length} nodes; the engine supports a single-node local cluster` };
  const raw = k(["get", "--raw", `/api/v1/nodes/${names[0]}/proxy/configz`]);
  if (raw.status !== 0) return { state: "pids_unreadable", detail: `its kubelet config could not be read (${publicDiagnostic(raw.stderr || raw.error || "no answer", ctx.env, ctx.platform)})` };
  try {
    const v = (JSON.parse(raw.stdout) as { kubeletconfig?: { podPidsLimit?: unknown } }).kubeletconfig?.podPidsLimit;
    return { pids: typeof v === "number" ? v : -1 };
  } catch {
    return { state: "pids_unreadable", detail: "its kubelet config was not JSON" };
  }
}

/** The engine's `cluster status` document, validated; `null` when it is not one. */
function statusDoc(stdout: string): { configured: boolean; reachable: boolean; controllerReady: boolean | null } | null {
  try {
    const v = JSON.parse(stdout.trim()) as Record<string, unknown> | null;
    if (v === null || typeof v !== "object" || Array.isArray(v) || typeof v.configured !== "boolean" || typeof v.reachable !== "boolean") return null;
    const c = v.controller as Record<string, unknown> | null | undefined;
    return { configured: v.configured, reachable: v.reachable, controllerReady: c !== null && typeof c === "object" && typeof c.ready === "boolean" ? c.ready : null };
  } catch {
    return null;
  }
}

/** The command an operator can paste: the resolved engine binary (home spelled ~), each word quoted. */
export function installCommand(core: string, t: Target, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return [publicPath(core, env, platform), "cluster", "install", "--admin-context", t.context, "--admin-kubeconfig", publicPath(t.kubeconfig, env, platform), "--home", publicPath(crewStateHome(env, platform), env, platform)]
    .map((w) => shellWord(w, platform)).join(" ")
    .replace(/^'/, platform === "win32" ? "& '" : "'");
}

/** The engine's environment for a target: kubectl pinned (`WICKED_KUBECTL`), no inherited KUBECONFIG. */
function engineEnv(env: NodeJS.ProcessEnv, t: Target): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, WICKED_KUBECTL: t.kubectl };
  // The engine's own overrides would point its status or install at another cluster than the one checked.
  delete out.KUBECONFIG;
  delete out.WICKED_K8S_KUBECONFIG;
  delete out.WICKED_K8S_CONTEXT;
  return out;
}

type Checked = KubeNeed & { target?: Target; core?: string };

/** The readiness need. Spawns nothing under `probeOnly`. */
export function checkKubernetes(ctx: KubeCtx): Checked {
  const { env, platform } = ctx;
  if (ctx.probeOnly) {
    const kubectl = findKubectl(env, platform);
    return kubectl === null
      ? { need: NEED, met: false, state: "no_kubectl", detail: "kubectl is not installed, so there is no local Kubernetes for crew's seats", remedy: `install Rancher Desktop or Docker Desktop, then ${START}` }
      : { need: NEED, met: true, verified: false, state: "unchecked", detail: `kubectl found at ${publicPath(kubectl, env, platform)}; the cluster was not checked (--dry-run)` };
  }
  const resolved = resolveTarget(ctx);
  if ("need" in resolved) return resolved.need;
  const t = resolved.target;
  const shownCtx = publicDiagnostic(t.context, env, platform);
  const fail = (state: KubeState, detail: string, remedy?: string, core?: string): Checked => ({ need: NEED, met: false, state, detail, ...(remedy ? { remedy } : {}), target: t, ...(core ? { core } : {}) });
  const version = ctx.spawn(t.kubectl, ["--kubeconfig", t.kubeconfig, "--context", t.context, "version", "-o", "json", "--request-timeout=10s"]);
  if (version.status !== 0) return fail("unreachable", `the ${shownCtx} cluster does not answer (${publicDiagnostic(version.stderr || version.error || "no answer", env, platform)})`, START);
  const node = readNode(t, ctx);
  if ("state" in node) return fail(node.state, `the ${shownCtx} cluster answers, but ${node.detail}`, node.state === "topology" ? "use Rancher Desktop's or Docker Desktop's single-node cluster" : `check it, or ${PIDS_FIX}`);
  if (node.pids <= 0 || node.pids > PODS_PIDS_MAX) {
    return fail("pids_unlimited", `the ${shownCtx} kubelet sets no pod process limit of ${PODS_PIDS_MAX} or less (podPidsLimit ${node.pids}), so the engine refuses every seat (pids_unlimited)`, PIDS_FIX);
  }
  const core = findWickedCore(env, platform);
  if (core === null) return fail("no_engine", `the ${shownCtx} cluster answers (pod process limit ${node.pids}), but the wicked-core binary that installs crew's part of it was not found`, "npm i -g wicked-crew (it carries wicked-core), then run the installer again");
  const status = ctx.spawn(core, ["cluster", "status", "--json", "--home", crewStateHome(env, platform)], { env: engineEnv(env, t) });
  const parsed = statusDoc(status.stdout);
  // A document counts only with the exit it belongs to: 0 for an installed daemon, 1 for "not configured".
  const doc = parsed !== null && status.error === undefined && ((status.status === 0 && parsed.configured) || (status.status === 1 && !parsed.configured && !parsed.reachable) || (status.status === 1 && parsed.configured && !parsed.reachable)) ? parsed : null;
  const command = `run \`${installCommand(core, t, env, platform)}\``;
  if (doc === null) {
    return fail("engine_unanswered", `wicked-core cluster status gave no status (${publicDiagnostic(status.stderr || status.error || "not a status document", env, platform)}); this wicked-core may predate the Kubernetes runner`, "npm i -g wicked-crew@latest, then run the installer again", core);
  }
  if (!doc.configured) return fail("not_installed", `the ${shownCtx} cluster answers and limits pod processes (${node.pids}), but crew's part of it is not installed; the install proves seat isolation`, `${command} (it also proves NetworkPolicy is enforced)`, core);
  if (!doc.reachable) return fail("daemon_unreachable", "crew's part of the cluster is installed but does not answer with crew's own account", START, core);
  if (doc.controllerReady === false) return fail("controller_not_ready", `the ${shownCtx} cluster's sandbox controller is not ready`, command, core);
  if (doc.controllerReady === null) return fail("engine_unanswered", "wicked-core cluster status could not read the sandbox controller", "run the installer again; if it persists, run `wicked-core cluster status --home ~/.wicked-crew` by hand", core);
  return { need: NEED, met: true, state: "ready", detail: `${shownCtx}: answers, pod process limit ${node.pids}, crew's part installed and its sandbox controller ready`, target: t, core };
}

export interface EnsureClusterResult {
  action: "not-needed" | "installed" | "already" | "skipped" | "failed";
  message: string;
}

/**
 * After crew is in place: install crew's part of the local cluster, on the target the check
 * resolved, when the engine reported it missing (or its controller not ready). A stopped cluster, a
 * missing pod process limit or a remote context is the operator's: nothing is changed. Under `dryRun`
 * nothing is spawned. `env` is crew's own environment (its PATH), as for readiness.
 */
export function ensureClusterForCrew(input: { productIds: string[]; dryRun: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; spawn?: Spawn }): EnsureClusterResult {
  if (!input.productIds.includes("wicked-crew")) return { action: "not-needed", message: "" };
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (findKubectl(env, platform) === null) return { action: "skipped", message: `No local Kubernetes yet: crew's governed seats run in pods. Install Rancher Desktop or Docker Desktop and ${START}, then run the installer again.` };
  if (input.dryRun) return { action: "skipped", message: "Would install crew's part of the local Kubernetes cluster (wicked-core cluster install) [dry-run]." };
  const spawn = input.spawn ?? defaultSpawn(env);
  const check = checkKubernetes({ env, platform, probeOnly: false, spawn });
  if (check.met) return { action: "already", message: `Kubernetes for crew: ${check.detail}.` };
  if ((check.state !== "not_installed" && check.state !== "controller_not_ready") || check.target === undefined || check.core === undefined) {
    return { action: "skipped", message: `Kubernetes for crew is not ready: ${check.detail}.${check.remedy ? ` Fix: ${check.remedy}.` : ""}` };
  }
  const t = check.target;
  const run = spawn(check.core, ["cluster", "install", "--admin-context", t.context, "--admin-kubeconfig", t.kubeconfig, "--home", crewStateHome(env, platform)], { timeoutMs: INSTALL_TIMEOUT_MS, env: engineEnv(env, t) });
  const shown = publicDiagnostic(t.context, env, platform);
  if (run.status === 0) return { action: "installed", message: `Installed crew's part of the ${shown} cluster (pod process limit and NetworkPolicy enforcement proven by wicked-core).` };
  if (run.timedOut === true) return { action: "failed", message: `wicked-core cluster install did not finish within ${INSTALL_TIMEOUT_MS / 60_000} min; the installer stopped waiting, and the engine's own steps may still be finishing. Check \`wicked-core cluster status --home ~/.wicked-crew\` before running \`${installCommand(check.core, t, env, platform)}\` again.` };
  return { action: "failed", message: `wicked-core cluster install refused the ${shown} cluster: ${publicDiagnostic(run.stderr || run.error || "no reason given", env, platform)}` };
}
