/**
 * The local Kubernetes cluster wicked-crew's governed seats run on (the k8s runner, wicked-core
 * k8s-swap). Two halves:
 *
 * - {@link checkKubernetes}: the readiness need (`kind: "kubernetes"`), read-only. kubectl is
 *   installed; a LOCAL context (Rancher Desktop's or Docker Desktop's, never the current context)
 *   answers; its kubelet limits each pod's processes (`podPidsLimit` 1..4096, read from the node's
 *   `configz`); and the engine's own `wicked-core cluster status` says this daemon's cluster is
 *   installed and its sandbox controller is ready.
 * - {@link ensureClusterForCrew}: after crew is installed, `wicked-core cluster install
 *   --admin-context <ctx> --home <crew's state home>`. The engine's install is the one that
 *   proves the cluster can hold seats: it forks past the pod process limit in a probe pod and
 *   checks a NetworkPolicy deny holds, and refuses (and removes what it made) when either fails.
 *
 * The installer never changes the cluster's own settings: a missing `pod-max-pids` is the
 * operator's call (a Rancher Desktop k3s argument), said with the fix.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Local contexts, in preference order. `WICKED_K8S_ADMIN_CONTEXT` names another one. */
export const LOCAL_CONTEXTS = ["rancher-desktop", "docker-desktop"] as const;
/** The process limit the engine's seats need (wicked-core `FloorUnarmed::PidsUnlimited`). */
export const PODS_PIDS_MAX = 4096;

export type Spawn = (bin: string, args: string[], timeoutMs?: number) => { status: number | null; stdout: string; stderr: string; error?: string };

export interface KubeCtx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** PATH probes only: spawn nothing (`--dry-run`). */
  probeOnly: boolean;
  spawn: Spawn;
}

export interface KubeNeed {
  need: string;
  met: boolean;
  verified?: boolean;
  detail: string;
  remedy?: string;
}

const NEED = "local Kubernetes (governed seats run in pods)";
const START = "start Rancher Desktop (Preferences → Kubernetes → Enable) or Docker Desktop (Settings → Kubernetes → Enable)";
const PIDS_FIX =
  `set the kubelet's pod-max-pids to ${PODS_PIDS_MAX}: on Rancher Desktop add \`kubelet-arg: ["pod-max-pids=${PODS_PIDS_MAX}"]\` to /etc/rancher/k3s/config.yaml in the VM ` +
  "(persist it with a provision script in ~/Library/Application Support/rancher-desktop/lima/_config/override.yaml) and restart Kubernetes";

export function defaultSpawn(env: NodeJS.ProcessEnv): Spawn {
  return (bin, args, timeoutMs = 20_000) => {
    const res = spawnSync(bin, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    const error = res.error ? ((res.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `timed out after ${timeoutMs / 1000}s` : res.error.message) : undefined;
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ...(error ? { error } : {}) };
  };
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/** kubectl on PATH, else where the desktop apps put it. */
export function findKubectl(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const name = platform === "win32" ? "kubectl.exe" : "kubectl";
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir !== "" && isFile(join(dir, name))) return join(dir, name);
  const home = homeOf(env);
  const extra = platform === "win32"
    ? [join("C:", "Program Files", "Docker", "Docker", "resources", "bin", name), join(home, ".rd", "bin", name)]
    : [join(home, ".rd", "bin", name), "/Applications/Docker.app/Contents/Resources/bin/kubectl"];
  return extra.find(isFile) ?? null;
}

/** crew's state home: `WICKED_CREW_HOME`, else `~/.wicked-crew` (crew's default `--db` parent). */
export function crewStateHome(env: NodeJS.ProcessEnv): string {
  const set = (env.WICKED_CREW_HOME ?? "").trim();
  return set !== "" ? set : join(homeOf(env), ".wicked-crew");
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

/** The `wicked-core` binary crew runs: `WICKED_CORE_EXE`, else the one bundled in the platform
 *  package beside the installed wicked-crew (as crew's own `bundledWickedCoreExe` resolves it). */
export function findWickedCore(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string = process.arch): string | null {
  const set = (env.WICKED_CORE_EXE ?? "").trim();
  if (set !== "") return isFile(set) ? set : null;
  const exe = platform === "win32" ? "wicked-core.exe" : "wicked-core";
  const pkg = platformPackage(platform, arch);
  if (pkg === null) return null;
  const crewBin = platform === "win32" ? "wicked-crew.cmd" : "wicked-crew";
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const bin = dir === "" ? "" : join(dir, crewBin);
    if (bin === "" || !existsSync(bin)) continue;
    // From the bin's real path, up to the wicked-crew package root; then its own and the hoisted node_modules.
    let at: string;
    try { at = dirname(realpathSync(bin)); } catch { continue; }
    for (let i = 0; i < 6; i++) {
      try {
        if ((JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as { name?: string }).name === "wicked-crew") {
          for (const p of [join(at, "node_modules", pkg, exe), join(dirname(at), pkg, exe)]) if (isFile(p)) return p;
          break;
        }
      } catch { /* not the package root */ }
      at = dirname(at);
    }
    // npm's Windows shim sits beside node_modules.
    const beside = join(dir, "node_modules", "wicked-crew", "node_modules", pkg, exe);
    if (isFile(beside)) return beside;
  }
  return null;
}

/** The local context to use: the operator's `WICKED_K8S_ADMIN_CONTEXT`, else the first of
 *  {@link LOCAL_CONTEXTS} kubectl knows. Never the current context. */
export function pickContext(contexts: string[], env: NodeJS.ProcessEnv): string | null {
  const named = (env.WICKED_K8S_ADMIN_CONTEXT ?? "").trim();
  if (named !== "") return contexts.includes(named) ? named : null;
  return LOCAL_CONTEXTS.find((c) => contexts.includes(c)) ?? null;
}

/** The node kubelet's `podPidsLimit` (`/api/v1/nodes/<node>/proxy/configz`), or why it could not be read. */
export function readPodPidsLimit(kubectl: string, context: string, ctx: KubeCtx): { limit: number | null; error?: string } {
  const node = ctx.spawn(kubectl, ["--context", context, "get", "nodes", "-o", "jsonpath={.items[0].metadata.name}", "--request-timeout=10s"]);
  const name = node.stdout.trim();
  if (node.status !== 0 || !/^[a-z0-9.-]{1,253}$/.test(name)) return { limit: null, error: firstLine(node.stderr) || node.error || "no node listed" };
  const raw = ctx.spawn(kubectl, ["--context", context, "get", "--raw", `/api/v1/nodes/${name}/proxy/configz`, "--request-timeout=10s"]);
  if (raw.status !== 0) return { limit: null, error: firstLine(raw.stderr) || raw.error || "the kubelet config could not be read" };
  try {
    const v = (JSON.parse(raw.stdout) as { kubeletconfig?: { podPidsLimit?: unknown } }).kubeletconfig?.podPidsLimit;
    return { limit: typeof v === "number" ? v : -1 };
  } catch {
    return { limit: null, error: "the kubelet config was not JSON" };
  }
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? "";
}

function installCommand(context: string, env: NodeJS.ProcessEnv): string {
  return `wicked-core cluster install --admin-context ${context} --home ${crewStateHome(env).replace(homeOf(env), "~")}`;
}

/** The readiness need. Spawns nothing under `probeOnly`. */
export function checkKubernetes(ctx: KubeCtx): KubeNeed {
  const kubectl = findKubectl(ctx.env, ctx.platform);
  if (kubectl === null) {
    return { need: NEED, met: false, detail: "kubectl is not installed, so there is no local Kubernetes for crew's seats", remedy: `install Rancher Desktop or Docker Desktop, then ${START}` };
  }
  if (ctx.probeOnly) return { need: NEED, met: true, verified: false, detail: `kubectl found at ${kubectl}; the cluster was not checked (--dry-run)` };
  const listed = ctx.spawn(kubectl, ["config", "get-contexts", "-o", "name"]);
  const context = pickContext(listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), ctx.env);
  if (context === null) {
    const named = (ctx.env.WICKED_K8S_ADMIN_CONTEXT ?? "").trim();
    return {
      need: NEED, met: false,
      detail: named !== "" ? `kubectl knows no context named ${named} (WICKED_K8S_ADMIN_CONTEXT)` : `kubectl knows no local context (${LOCAL_CONTEXTS.join(" or ")}); the current context is never used`,
      remedy: START,
    };
  }
  const version = ctx.spawn(kubectl, ["--context", context, "version", "-o", "json", "--request-timeout=10s"]);
  if (version.status !== 0) return { need: NEED, met: false, detail: `the ${context} cluster does not answer (${firstLine(version.stderr) || version.error || "no answer"})`, remedy: START };
  const pids = readPodPidsLimit(kubectl, context, ctx);
  if (pids.limit === null) return { need: NEED, met: false, detail: `the ${context} kubelet's pod process limit could not be read (${pids.error})`, remedy: `check it, or ${PIDS_FIX}` };
  if (pids.limit <= 0 || pids.limit > PODS_PIDS_MAX) {
    return { need: NEED, met: false, detail: `the ${context} kubelet sets no pod process limit of ${PODS_PIDS_MAX} or less (podPidsLimit ${pids.limit}), so the engine refuses every seat (pids_unlimited)`, remedy: PIDS_FIX };
  }
  const core = findWickedCore(ctx.env, ctx.platform);
  if (core === null) return { need: NEED, met: false, detail: `the ${context} cluster answers (pod process limit ${pids.limit}), but the wicked-core binary that installs crew's part of it was not found`, remedy: "npm i -g wicked-crew (it carries wicked-core), then run the installer again" };
  const status = ctx.spawn(core, ["cluster", "status", "--json", "--home", crewStateHome(ctx.env)]);
  type StatusDoc = { configured?: unknown; reachable?: unknown; controller?: { ready?: unknown } };
  const doc = ((): StatusDoc | null => {
    try { const v: unknown = JSON.parse(status.stdout.trim()); return v !== null && typeof v === "object" ? (v as StatusDoc) : null; } catch { return null; }
  })();
  if (doc === null) return { need: NEED, met: false, detail: `wicked-core cluster status gave no answer (${firstLine(status.stderr) || status.error || "not a status"}); this wicked-core may predate the Kubernetes runner`, remedy: "npm i -g wicked-crew@latest, then run the installer again" };
  if (doc.configured !== true) return { need: NEED, met: false, detail: `the ${context} cluster is ready (pod process limit ${pids.limit}), but crew's part of it is not installed`, remedy: `run \`${installCommand(context, ctx.env)}\` (it also proves NetworkPolicy is enforced)` };
  if (doc.reachable !== true) return { need: NEED, met: false, detail: "crew's cluster is installed but does not answer with crew's own account", remedy: START };
  if (doc.controller?.ready !== true) return { need: NEED, met: false, detail: `the ${context} cluster's sandbox controller is not ready`, remedy: `run \`${installCommand(context, ctx.env)}\`` };
  return { need: NEED, met: true, detail: `${context}: answers, pod process limit ${pids.limit}, crew's cluster installed and its sandbox controller ready` };
}

export interface EnsureClusterResult {
  action: "not-needed" | "installed" | "already" | "skipped" | "failed";
  message: string;
}

/**
 * After crew is in place: install crew's part of the local cluster when it can (kubectl, a local
 * context that answers, a pod process limit). The engine's install proves pids and NetworkPolicy
 * enforcement itself and refuses a cluster that fails either. Under `dryRun` it only says what it would run.
 */
export function ensureClusterForCrew(input: { productIds: string[]; dryRun: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; spawn?: Spawn }): EnsureClusterResult {
  if (!input.productIds.includes("wicked-crew")) return { action: "not-needed", message: "" };
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const kubectl = findKubectl(env, platform);
  if (kubectl === null) return { action: "skipped", message: `No local Kubernetes yet: crew's governed seats run in pods. Install Rancher Desktop or Docker Desktop and ${START}, then run the installer again.` };
  if (input.dryRun) return { action: "skipped", message: "Would install crew's part of the local Kubernetes cluster (wicked-core cluster install) [dry-run]." };
  const spawn = input.spawn ?? defaultSpawn(env);
  const check = checkKubernetes({ env, platform, probeOnly: false, spawn });
  if (check.met) return { action: "already", message: `Kubernetes for crew: ${check.detail}.` };
  const listed = spawn(kubectl, ["config", "get-contexts", "-o", "name"]);
  const context = pickContext(listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), env);
  // Only an unmet INSTALL is the installer's to fix; a cluster setting or a stopped cluster is the operator's.
  if (context === null || !/is not installed|sandbox controller is not ready/.test(check.detail)) {
    return { action: "skipped", message: `Kubernetes for crew is not ready: ${check.detail}.${check.remedy ? ` Fix: ${check.remedy}.` : ""}` };
  }
  const core = findWickedCore(env, platform);
  if (core === null) return { action: "failed", message: "The wicked-core binary was not found, so crew's cluster could not be installed." };
  const run = spawn(core, ["cluster", "install", "--admin-context", context, "--home", crewStateHome(env)], 180_000);
  if (run.status === 0) return { action: "installed", message: `Installed crew's part of the ${context} cluster (pod process limit and NetworkPolicy enforcement proven by wicked-core).` };
  return { action: "failed", message: `wicked-core cluster install refused the ${context} cluster: ${firstLine(run.stderr) || run.error || "no reason given"}` };
}
