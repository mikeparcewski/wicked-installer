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
import { dirname } from "node:path";
import { findInstalledBinary, pathFix } from "./release-binary.js";
import { findUv, uvInstallCommand } from "./uv.js";
import { CREW_FINDS_INSTALLER_LOCATIONS, crewEnv, crewKnowsInstallerLocations, findGardenForCrew, homeOf, isCrewGardenHit } from "./crew-garden.js";

/**
 * `unchecked` = nothing is known to be missing, but a need was only found on PATH and not
 * verified (its self-check or version was not run — `--dry-run`). Never shown as `ready`.
 */
export type ReadinessState = "ready" | "pending" | "unchecked" | "n/a";

/**
 * Hosts whose hook events the installer wires (INTERFACE.md §8.4: a CLI wires hooks only once its
 * hook config and event model are stated there — today only Claude Code's settings.json is).
 * On every other host a product's hooks are not installed, so nothing it ships blocks by itself.
 */
export const HOOK_HOSTS: ReadonlySet<string> = new Set(["claude"]);

/** Hosts with no hook events at all. Pi and OpenCode have none the installer wires either, but take a product's own adapter (hooks/pi-extension.ts, hooks/opencode-plugin.ts) when it ships one. */
const ADAPTER_HOSTS: ReadonlySet<string> = new Set(["pi", "opencode"]);

const HOST_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi", antigravity: "Antigravity" };

function hostName(host: string): string {
  return HOST_NAMES[host] ?? host.charAt(0).toUpperCase() + host.slice(1);
}

export interface NeedResult {
  /** e.g. "launcher wicked-garden", "python >= 3.10", "backend wicked-vault". */
  need: string;
  met: boolean;
  /** false when `met` rests on a PATH probe alone (the self-check / version was not run). */
  verified?: boolean;
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
  /**
   * Per product, the hosts it was actually delivered to (overrides `hosts` for that product). A
   * host whose delivery FAILED is not one: a failed Claude Code registration must not leave a
   * "ready … (Claude Code)" row behind (first-run C5).
   */
  hostsFor?: (productId: string) => string[];
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
  /** Did the host's script install a hook adapter for the product (its report / marker `assets.hooks` > 0)? */
  hookAdapter?: (host: string, productId: string) => boolean;
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
  /** Judging wicked-crew's own needs: crew resolves binaries on its PATH only (env is crewEnv). */
  crew?: boolean;
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

/** The checked environment's home (tests and sandboxes set HOME), else this user's. */
function homeOfCtx(ctx: Ctx): string {
  return homeOf(ctx.env, ctx.platform);
}

function checkBin(need: Extract<CapabilityNeed, { bin: string }>, ctx: Ctx): NeedResult {
  const label = `${need.kind} ${need.bin}`;
  const install = need.npx
    ? `npm i -g ${need.npx}`
    : need.product ? `npx wicked-installer install ${need.product}` : `put ${need.bin} on PATH`;
  const probe = probeOnPath(need.bin, ctx.env, ctx.platform);
  if (probe.state === "found") {
    if (!need.doctor) return { need: label, met: true, detail: `on PATH (${probe.path})` };
    if (ctx.probeOnly) return { need: label, met: true, verified: false, detail: `on PATH (${probe.path}); \`${need.bin} ${need.doctor.join(" ")}\` not run under --dry-run` };
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
  if (need.product) {
    // Installed by the installer, off PATH: ~/.local/bin (release) or ~/.cargo/bin (cargo). The
    // installer's MCP entries and garden's launcher use that absolute path, so it runs; a shell does not find it.
    // Not for crew: its daemon runs `wicked-estate` by name on its own PATH (ctx.env), never through an MCP entry.
    const off = ctx.crew ? undefined : findInstalledBinary(need.bin, { env: ctx.env, platform: ctx.platform, home: homeOfCtx(ctx) });
    if (off && off.source !== "PATH") {
      return { need: label, met: true, detail: `installed at ${off.path} (not on PATH: MCP entries use this path; to run it from a shell, ${pathFix(dirname(off.path), ctx.platform)})` };
    }
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
    if (ctx.probeOnly) return { need: label, met: true, verified: false, detail: `${name} on PATH (${probe.path}); version not checked under --dry-run` };
    const res = ctx.spawn(probe.path, [...pre, "--version"]);
    const version = firstLine(`${res.stdout}\n${res.stderr}`.trim());
    if (res.status === 0 && versionAtLeast(version, need.min)) {
      return { need: label, met: true, detail: `${name}${pre.length ? ` ${pre.join(" ")}` : ""}: ${version}` };
    }
    seen.push(`${name}: ${res.status === 0 ? version || "no version" : res.error ?? `exit ${res.status ?? "?"}`}`);
  }
  const none = seen.length > 0 ? `no interpreter at or above ${need.min} (${seen.join("; ")})` : "no python3 / python on PATH";
  // first-run-2 N2: name a real command. uv is the one mechanism: garden's launcher runs scripts
  // with a uv-managed Python when uv is on PATH; a host that calls python3 itself (Claude Code's
  // hooks) gets a uv-managed python3 installed as the default.
  const uv = findUv({ env: ctx.env, platform: ctx.platform, home: homeOfCtx(ctx) });
  if (need.launcher && uv?.onPath) {
    // The launcher's rung is `uv run --project <root> --frozen --no-dev python`: it needs a uv that answers and
    // knows those flags (uv >= UV_MIN); garden's npm package and plugin copies ship the uv.lock that rung reads.
    if (ctx.probeOnly) return { need: label, met: true, verified: false, detail: `${none}; uv at ${uv.path} is on PATH (version not checked under --dry-run)` };
    const res = ctx.spawn(uv.path, ["--version"]);
    const version = firstLine(`${res.stdout}\n${res.stderr}`.trim());
    if (res.status === 0 && versionAtLeast(version, UV_MIN)) {
      return { need: label, met: true, detail: `${none}; ${version} at ${uv.path} is on PATH, so garden's launcher runs scripts with a uv-managed Python ${need.min}+ (uv downloads it at first use)` };
    }
    return { need: label, met: false, detail: `${none}; uv at ${uv.path} ${res.status === 0 ? `is ${version || "of an unknown version"}, older than ${UV_MIN}` : "did not answer --version"}`, remedy: "run `uv self update` (or reinstall uv)" };
  }
  // `--default` is a preview feature (uv 0.6 refuses it without `--preview`); a path with a space is quoted.
  const uvCmd = uv && !uv.onPath ? (/\s/.test(uv.path) ? `${ctx.platform === "win32" ? "& " : ""}"${uv.path}"` : uv.path) : "uv";
  const pyInstall = `${uvCmd} python install ${UV_PYTHON} --default --preview`;
  let remedy: string;
  if (uv === undefined) {
    remedy = need.launcher
      ? `install uv (${uvInstallCommand(ctx.platform, ctx.env)}), then open a new terminal: garden's launcher runs scripts with a uv-managed Python`
      : `install uv (${uvInstallCommand(ctx.platform, ctx.env)}), open a new terminal, then run \`uv python install ${UV_PYTHON} --default --preview\``;
  } else if (!uv.onPath) {
    remedy = need.launcher
      ? `uv is installed at ${uv.path} but not on PATH; ${pathFix(dirname(uv.path), ctx.platform)}. Garden's launcher then runs scripts with a uv-managed Python`
      : `run \`${pyInstall}\`, then ${pathFix(dirname(uv.path), ctx.platform)}`;
  } else {
    remedy = `run \`${pyInstall}\` (it puts python3 in uv's bin directory, ~/.local/bin by default, which must come before /usr/bin on PATH)`;
  }
  return { need: label, met: false, detail: none, remedy };
}

/** The Python a remedy asks uv for: inside garden's `requires-python` (>=3.10,<3.15). */
const UV_PYTHON = "3.12";
/** The oldest uv whose `uv run` takes `--frozen --no-dev` and downloads a managed Python on demand. */
const UV_MIN = "0.5.0";

function checkNeed(need: CapabilityNeed, ctx: Ctx): NeedResult {
  if (need.kind === "uv") {
    // Only wicked-crew declares this need, and its ctx.env carries crew's own PATH (see preflight):
    // "met" = crew's `uv sync` will find it. A uv elsewhere (UV_INSTALL_DIR, CARGO_HOME) needs PATH.
    const found = findUv({ env: ctx.env, platform: ctx.platform, home: homeOfCtx(ctx) });
    if (found?.onPath) return { need: "uv", met: true, detail: `found at ${found.path}` };
    if (found) return { need: "uv", met: false, detail: `installed at ${found.path}, which is not on PATH, so crew's \`uv sync\` cannot find it`, remedy: pathFix(dirname(found.path), ctx.platform) };
    return { need: "uv", met: false, detail: "not installed; wicked-crew needs uv to build each job's skills environment", remedy: uvInstallCommand(ctx.platform, ctx.env) };
  }
  if (need.kind === "crew-garden") {
    // Garden delivered to some host is not garden crew can load (first-run B3): check crew's own sources.
    const hit = findGardenForCrew(ctx.env, ctx.platform);
    if (isCrewGardenHit(hit)) {
      return { need: "wicked-garden for crew", met: true, detail: `${hit.source}, version ${hit.version} (${hit.path}); crew checks its minimum garden version at boot` };
    }
    if (hit) return { need: "wicked-garden for crew", met: false, detail: hit.refused };
    const modern = crewKnowsInstallerLocations(ctx.env, ctx.platform);
    return {
      need: "wicked-garden for crew",
      met: false,
      detail: modern
        ? "crew finds no wicked-garden plugin (it looks in Claude Code's and Codex's plugin caches and the wicked-garden npm package), so it would refuse every job"
        : `the wicked-crew on PATH is older than ${CREW_FINDS_INSTALLER_LOCATIONS} and looks for wicked-garden only in Claude Code's plugin dirs, where there is none, so it would refuse every job`,
      remedy: modern ? "npm i -g wicked-garden" : "npm i -g wicked-crew@latest",
    };
  }
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
    const hosts = opts.hostsFor ? opts.hostsFor(product.id) : opts.hosts;
    // crew's daemon looks up its tools on its own PATH (it appends ~/.local/bin & co. at boot):
    // judge crew's needs against that, not against this shell's PATH.
    const pctx = product.id === "wicked-crew" ? { ...ctx, crew: true, env: crewEnv(ctx.env, ctx.platform) } : ctx;
    for (const cap of caps) {
      if (!applies(cap, hosts)) continue;
      const needs = (Array.isArray(cap.needs) ? cap.needs : []).map((n) => checkNeed(n, pctx));
      out.push({
        productId: product.id,
        capability: cap.id,
        label: cap.label,
        optional: cap.optional === true,
        state: !needs.every((n) => n.met) ? "pending" : needs.some((n) => n.verified === false) ? "unchecked" : "ready",
        needs,
      });
    }
    // Say plainly where a product's hooks do not exist (no silent gap): one `n/a` row per host
    // without hook events. Never pending — there is nothing to install — and never "ready".
    if (product.shipsHooks === true && Array.isArray(hosts)) {
      for (const host of hosts) {
        if (HOOK_HOSTS.has(host)) continue;
        const adapterHost = ADAPTER_HOSTS.has(host);
        if (adapterHost && opts.hookAdapter?.(host, product.id) === true) continue; // the product's own adapter is installed
        const why = adapterHost
          ? `no ${product.id} hook adapter was installed for ${hostName(host)} (the installer wires no ${hostName(host)} hook events)`
          : `${hostName(host)} has no hook events, so no ${product.id} hook was installed`;
        out.push({
          productId: product.id,
          capability: `hooks:${host}`,
          label: `hooks — ${why}; nothing blocks on its own there: the evidence gate runs only when a skill calls it`,
          optional: true,
          state: "n/a",
          needs: [],
        });
      }
    }
  }
  return out;
}
