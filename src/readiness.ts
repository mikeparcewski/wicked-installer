/**
 * Capability readiness (EXP-01): is what the installer delivered actually RUNNABLE here?
 *
 * The install result already says what happened per product and CLI — `registered` (wired into
 * the host), `copied` (files placed, nothing registered), `acquired` (a binary), `manual`. None of
 * those answers "will the capability run?": Garden's skills copied into Codex reach their scripts
 * only through the `wicked-garden` launcher and a Python 3 interpreter, and its evidence gate needs
 * the `wicked-vault` backend. This module checks each capability's declared needs
 * (registry.json `capabilities`) and answers `ready` or `pending`, with the reason and the remedy.
 *
 * Read-only by construction: PATH probes are filesystem lookups, and the only things spawned are
 * `<bin> <doctor…>` self-checks, `python --version`, and `npm view <pkg> version` (a registry
 * lookup that installs nothing). An `npx` fallback is NEVER counted as ready: it resolves a
 * package at first use, which needs the network and a registry that answers — "resolvable" is not
 * "runnable offline" — so a missing launcher with a reachable fallback is still `pending`.
 */
import { spawnSync } from "node:child_process";
import { prepareClaudeSpawn, probeOnPath } from "./claude-plugin.js";
import type { Capability, CapabilityNeed, Product } from "./types.js";

export type ReadinessState = "ready" | "pending";

export interface NeedResult {
  /** e.g. "launcher wicked-garden", "python >= 3.10", "backend wicked-vault". */
  need: string;
  met: boolean;
  detail: string;
  /** What to do when unmet. */
  remedy?: string;
}

export interface CapabilityReadiness {
  productId: string;
  capability: string;
  label: string;
  optional: boolean;
  state: ReadinessState;
  needs: NeedResult[];
}

export interface PreflightOptions {
  /** CLI slugs the products were delivered to; a capability with `hosts` is checked only when one matches. Absent ⇒ every capability. */
  hosts?: string[];
  /** Skip the network: the npx fallback is reported as not checked. */
  offline?: boolean;
  /**
   * PATH probes only — spawn nothing (`--dry-run`, whose contract allows no spawn but the
   * `claude --version` probe, INTERFACE.md §13). Found-on-PATH counts as met and says the
   * self-check / version was not run; the npx fallback is reported as not checked.
   */
  probeOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Seam for tests; default spawns synchronously with a timeout. */
  spawn?: (bin: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: string };
}

const SPAWN_TIMEOUT_MS = 20_000;

function defaultSpawn(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  return (bin: string, args: string[]) => {
    let prepared;
    try {
      prepared = prepareClaudeSpawn(bin, args, platform);
    } catch (err) {
      return { status: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) };
    }
    const res = spawnSync(prepared.cmd, prepared.argv, {
      env,
      encoding: "utf8",
      shell: prepared.shell,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SPAWN_TIMEOUT_MS,
    });
    const error = res.error ? ((res.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `timed out after ${SPAWN_TIMEOUT_MS / 1000}s` : res.error.message) : undefined;
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ...(error ? { error } : {}) };
  };
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? "";
}

/** `X.Y[.Z]` ≥ `min`? Unparseable ⇒ false. */
export function versionAtLeast(found: string, min: string): boolean {
  const a = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(found);
  const b = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(min);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(a[i] ?? 0);
    const y = Number(b[i] ?? 0);
    if (x !== y) return x > y;
  }
  return true;
}

interface Ctx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  offline: boolean;
  probeOnly: boolean;
  spawn: NonNullable<PreflightOptions["spawn"]>;
  npxCache: Map<string, { reachable: boolean; detail: string }>;
}

/** Can the `npx <pkg>` fallback resolve the package right now? Never "ready" either way. */
function npxReachable(pkg: string, ctx: Ctx): { reachable: boolean; detail: string } {
  const cached = ctx.npxCache.get(pkg);
  if (cached) return cached;
  let out: { reachable: boolean; detail: string };
  const npm = probeOnPath("npm", ctx.env, ctx.platform);
  if (npm.state !== "found") {
    out = { reachable: false, detail: "npm is not on PATH, so there is no npx fallback" };
  } else {
    const res = ctx.spawn(npm.path, ["view", pkg, "version"]);
    const version = firstLine(res.stdout);
    out = res.status === 0 && version
      ? { reachable: true, detail: `npm registry answers (${pkg}@${version})` }
      : { reachable: false, detail: `npm registry unreachable (${res.error ?? (firstLine(res.stderr) || (res.status === 0 ? "no version in the reply" : `exit ${res.status ?? "?"}`))})` };
  }
  ctx.npxCache.set(pkg, out);
  return out;
}

function checkBin(need: Extract<CapabilityNeed, { bin: string }>, ctx: Ctx): NeedResult {
  const label = `${need.kind} ${need.bin}`;
  const install = need.npx
    ? `npm i -g ${need.npx}`
    : need.product ? `npx wicked-installer install ${need.product}` : `put ${need.bin} on PATH`;
  const probe = probeOnPath(need.bin, ctx.env, ctx.platform);
  if (probe.state === "found") {
    if (!need.doctor) return { need: label, met: true, detail: `on PATH (${probe.path})` };
    if (ctx.probeOnly) return { need: label, met: true, detail: `on PATH (${probe.path}); \`${need.bin} ${need.doctor.join(" ")}\` not run under --dry-run` };
    const res = ctx.spawn(probe.path, need.doctor);
    let report: { ok?: unknown; reason?: unknown; python?: { kind?: unknown; version?: unknown; reason?: unknown } } | undefined;
    try {
      report = JSON.parse(res.stdout);
    } catch {
      report = undefined;
    }
    if (report && report.ok === true && res.status === 0 && !res.error) {
      const py = report.python && typeof report.python.kind === "string" ? `, python ${String(report.python.version ?? report.python.kind)}` : "";
      return { need: label, met: true, detail: `on PATH; \`${need.bin} ${need.doctor.join(" ")}\` ok${py}` };
    }
    const why = res.error
      ? res.error
      : report
      ? String(report.reason ?? report.python?.reason ?? (report.ok === true ? `self-check exited ${res.status ?? "?"}` : "self-check reported not ok"))
      : (firstLine(res.stderr) || `no JSON from \`${need.bin} ${need.doctor.join(" ")}\` (exit ${res.status ?? "?"})`);
    return { need: label, met: false, detail: `on PATH but its self-check failed: ${why}`, remedy: `run \`${need.bin} ${need.doctor.join(" ")}\` and fix what it reports` };
  }
  if (probe.state === "unknown") {
    return { need: label, met: false, detail: `could not check PATH (${probe.reason})`, remedy: install };
  }
  if (!need.npx) return { need: label, met: false, detail: "not on PATH", remedy: install };
  if (ctx.offline || ctx.probeOnly) {
    return { need: label, met: false, detail: `not on PATH; the \`npx ${need.npx}\` fallback was not checked (${ctx.offline ? "--offline" : "--dry-run"}) and needs the network at first use`, remedy: `${install} (while online)` };
  }
  const npx = npxReachable(need.npx, ctx);
  return npx.reachable
    ? { need: label, met: false, detail: `not on PATH; only the \`npx ${need.npx}\` fallback is available — ${npx.detail}, but it fetches at first use and fails offline`, remedy: `${install} to make it ready offline` }
    : { need: label, met: false, detail: `not on PATH, and the \`npx ${need.npx}\` fallback cannot resolve it: ${npx.detail}`, remedy: `${install} once online` };
}

function checkPython(need: Extract<CapabilityNeed, { kind: "python" }>, ctx: Ctx): NeedResult {
  const label = `python >= ${need.min}`;
  // The launcher's own ladder after .venv/uv: python3 → python → py -3 (Windows only).
  const candidates: Array<[string, string[]]> = [["python3", []], ["python", []]];
  if (ctx.platform === "win32") candidates.push(["py", ["-3"]]);
  const seen: string[] = [];
  for (const [name, pre] of candidates) {
    const probe = probeOnPath(name, ctx.env, ctx.platform);
    if (probe.state !== "found") continue;
    if (ctx.probeOnly) return { need: label, met: true, detail: `${name} on PATH (${probe.path}); version not checked under --dry-run` };
    const res = ctx.spawn(probe.path, [...pre, "--version"]);
    const version = firstLine(`${res.stdout}\n${res.stderr}`.trim());
    if (res.status === 0 && versionAtLeast(version, need.min)) {
      return { need: label, met: true, detail: `${name}${pre.length ? ` ${pre.join(" ")}` : ""}: ${version}` };
    }
    seen.push(`${name}: ${res.status === 0 ? version || "no version" : res.error ?? `exit ${res.status ?? "?"}`}`);
  }
  return {
    need: label,
    met: false,
    detail: seen.length > 0 ? `no interpreter at or above ${need.min} (${seen.join("; ")})` : "no python3 / python on PATH",
    remedy: `install Python ${need.min}+`,
  };
}

function checkNeed(need: CapabilityNeed, ctx: Ctx): NeedResult {
  return need.kind === "python" ? checkPython(need, ctx) : checkBin(need, ctx);
}

function applies(cap: Capability, hosts: string[] | undefined): boolean {
  if (!hosts || !Array.isArray(cap.hosts)) return true;
  return cap.hosts.some((h) => hosts.includes(h));
}

/** Check every declared capability of `products` (registry order kept). Products without a `capabilities` block contribute nothing. */
export function preflight(products: Product[], opts: PreflightOptions = {}): CapabilityReadiness[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const ctx: Ctx = { env, platform, offline: opts.offline === true, probeOnly: opts.probeOnly === true, spawn: opts.spawn ?? defaultSpawn(env, platform), npxCache: new Map() };
  const out: CapabilityReadiness[] = [];
  for (const product of products) {
    const caps = Array.isArray(product.capabilities) ? product.capabilities : [];
    for (const cap of caps) {
      if (!applies(cap, opts.hosts)) continue;
      const needs = (Array.isArray(cap.needs) ? cap.needs : []).map((n) => checkNeed(n, ctx));
      out.push({
        productId: product.id,
        capability: cap.id,
        label: cap.label,
        optional: cap.optional === true,
        state: needs.every((n) => n.met) ? "ready" : "pending",
        needs,
      });
    }
  }
  return out;
}
