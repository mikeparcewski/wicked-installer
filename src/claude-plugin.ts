import { accessSync, constants as fsConstants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// wicked-garden is a Claude Code PLUGIN, and Claude Code only loads plugins it has
// REGISTERED: a marketplace entry in <configDir>/plugins/known_marketplaces.json plus
// an install record in <configDir>/plugins/installed_plugins.json whose payload lives
// under <configDir>/plugins/cache/<marketplace>/<plugin>/<version>/. That cache is
// also the only place wicked-crew's skills discovery reads.
//
// A bare copy under ~/.claude/plugins/<plugin>/ — what `npx wicked-garden install`
// produces, always into ~/.claude regardless of CLAUDE_CONFIG_DIR — is loaded by
// nothing. So this module drives Claude Code's OWN plugin mechanism (`claude plugin
// marketplace add`, `claude plugin install|update`) with CLAUDE_CONFIG_DIR pinned to
// each active config dir, and re-derives the registration from disk afterwards.
//
// One plan for dry-run and live. `planForDir` decides what to run from two probes —
// `claude --version` (a spawn; verified to write nothing) and the on-disk registration
// state — and both the dry run and the live run print those probes, then the live run
// executes exactly the planned commands. The state is read from disk rather than via
// `claude plugin marketplace list` / `claude plugin list` because those, although
// queries, initialise <configDir>/.claude.json and a backups/ entry as a side effect
// (observed on an empty config dir) — unacceptable for a dry run and for `status`.
// The files are what those commands print (their --json output mirrors them 1:1).
//
// Config-dir resolution mirrors install-claude.ts: --claude-home flags → CLAUDE_CONFIG_DIR
// (exclusive when the variable is SET; set-but-empty is an error) → ~/.claude.
// ---------------------------------------------------------------------------

export interface ClaudePluginSpec {
  /** `<plugin>@<marketplace>` — the id `claude plugin install|update|list` uses. */
  pluginId: string;
  pluginName: string;
  marketplaceName: string;
  /** What `claude plugin marketplace add` receives by default: GitHub `owner/repo`. */
  source: string;
}

export const DEFAULT_MARKETPLACE_OWNER = "mikeparcewski";

/** Env override for the Claude Code binary (tests point it at a spawn-recording fake). */
export const CLAUDE_BIN_ENV = "WICKED_CLAUDE_BIN";

export function claudePluginSpec(product: { id: string; install: { marketplace?: string; pluginId?: string } }): ClaudePluginSpec {
  const pluginId = product.install.pluginId ?? `${product.id}@${product.id}`;
  const at = pluginId.indexOf("@");
  const pluginName = at === -1 ? pluginId : pluginId.slice(0, at);
  const marketplaceName = at === -1 ? pluginId : pluginId.slice(at + 1);
  return {
    pluginId,
    pluginName,
    marketplaceName,
    source: product.install.marketplace ?? `${DEFAULT_MARKETPLACE_OWNER}/${product.id}`,
  };
}

// ---------------------------------------------------------------------------
// Config-dir resolution (install-claude.ts §11.1 policy, mirrored)
// ---------------------------------------------------------------------------

export type ConfigDirOrigin = "flag" | "env" | "default";

export interface ClaudeConfigDirs {
  dirs: string[];
  origin: ConfigDirOrigin;
}

export function describeOrigin(origin: ConfigDirOrigin): string {
  return origin === "flag" ? "--claude-home" : origin === "env" ? "CLAUDE_CONFIG_DIR" : "default ~/.claude";
}

// Leading ~ only, followed by /, \, or end-of-string. Function replacement so a $ in the
// home path cannot be interpreted as a replacement token.
function expandHome(value: string, home: string): string {
  return value.replace(/^~(?=$|[/\\])/, () => home);
}

// Split CLAUDE_CONFIG_DIR on path.delimiter + ',' — ';'+',' on Windows so a bare ':'
// can never shatter a C:\ path; ':'+',' elsewhere.
export function splitConfigDirValue(value: string, platform: NodeJS.Platform = process.platform): string[] {
  return value
    .split(platform === "win32" ? /[;,]/ : /[:,]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Resolve the Claude config dir(s) to act on. The default ~/.claude applies only when
 * CLAUDE_CONFIG_DIR is ABSENT: a variable that is set but names no directory ("", blanks,
 * a bare ":" or ",") is a misconfiguration and throws — silently acting on ~/.claude
 * would install into a dir the user has explicitly steered Claude Code away from.
 */
export function resolveClaudeConfigDirs(
  opts: { homeFlags?: string[]; env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform } = {},
): ClaudeConfigDirs {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  // 1. Explicit flags win as the full set.
  const flags = (opts.homeFlags ?? []).map((d) => resolve(expandHome(d, home)));
  if (flags.length > 0) return { dirs: [...new Set(flags)], origin: "flag" };

  // 2. CLAUDE_CONFIG_DIR is authoritative and exclusive when set.
  if ("CLAUDE_CONFIG_DIR" in env) {
    const raw = env.CLAUDE_CONFIG_DIR ?? "";
    const dirs = splitConfigDirValue(raw, opts.platform).map((d) => resolve(expandHome(d, home)));
    if (dirs.length === 0) {
      throw new Error(
        `CLAUDE_CONFIG_DIR is set but names no directory (value: ${JSON.stringify(raw)}) — unset it to use ~/.claude, or point it at a config dir`,
      );
    }
    return { dirs: [...new Set(dirs)], origin: "env" };
  }

  // 3. Only ~/.claude is a config root Claude Code reads by default.
  return { dirs: [resolve(home, ".claude")], origin: "default" };
}

// ---------------------------------------------------------------------------
// Locating the Claude Code CLI without spawning
// ---------------------------------------------------------------------------

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `cmd` against PATH (and PATHEXT on Windows) with filesystem probes only. */
export function findOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** The Claude Code binary to drive: WICKED_CLAUDE_BIN (tests) or `claude` on PATH. */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[CLAUDE_BIN_ENV];
  if (override) return existsSync(override) ? resolve(override) : undefined;
  return findOnPath("claude", env);
}

// ---------------------------------------------------------------------------
// Spawning the CLI with CLAUDE_CONFIG_DIR pinned
// ---------------------------------------------------------------------------

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type ClaudeSpawner = (bin: string, args: string[], configDir: string, mode: "capture" | "inherit") => SpawnResult;

// Quote ONE argument for cmd.exe when spawning a .cmd shim with { shell: true } —
// verbatim from INTERFACE.md §1.1 (CommandLineToArgvW backslash/quote rule).
function winQuote(arg: string): string {
  if (arg === "") return '""';
  if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; ) {
    let slashes = 0;
    while (i < arg.length && arg[i] === "\\") { slashes += 1; i += 1; }
    if (i === arg.length) { out += "\\".repeat(slashes * 2); break; }
    else if (arg[i] === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; i += 1; }
    else { out += "\\".repeat(slashes) + arg[i]; i += 1; }
  }
  return `${out}"`;
}

export interface PreparedSpawn {
  cmd: string;
  argv: string[];
  shell: boolean;
}

/**
 * How to launch `bin`: a .js/.mjs file goes through node (never rely on a shebang —
 * Windows); a Windows .cmd/.bat shim must go through cmd.exe with cmd-quoted args.
 * cmd.exe expands %VAR% (and !VAR!) even inside quotes and there is no escape for
 * them (INTERFACE.md §1.1), so a %/!-bearing argument — e.g. a `--source-root`
 * checkout under `%TEMP%` — would be rewritten before Claude Code ever saw it. Such
 * arguments are refused rather than silently changed. Pure, so it is unit-testable
 * for win32 from any platform.
 */
export function prepareClaudeSpawn(bin: string, args: string[], platform: NodeJS.Platform = process.platform): PreparedSpawn {
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, argv: [bin, ...args], shell: false };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const unsafe = [bin, ...args].filter((a) => /[%!]/.test(a));
    if (unsafe.length > 0) {
      throw new Error(
        `refusing to route ${unsafe.map((a) => JSON.stringify(a)).join(", ")} through cmd.exe: ` +
          "% and ! cannot be quoted for a .cmd shim (INTERFACE.md §1.1) — use a path without them, or a native claude.exe",
      );
    }
    return { cmd: winQuote(bin), argv: args.map(winQuote), shell: true };
  }
  return { cmd: bin, argv: args, shell: false };
}

/**
 * Run the Claude Code CLI once with CLAUDE_CONFIG_DIR=<configDir>. `capture` pipes
 * stdout/stderr (probes); `inherit` streams them so marketplace clones and install
 * progress — and any consent prompt Claude Code raises — reach the user.
 */
export const spawnClaude: ClaudeSpawner = (bin, args, configDir, mode) => {
  let prepared: PreparedSpawn;
  try {
    prepared = prepareClaudeSpawn(bin, args);
  } catch (err) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  const res = spawnSync(prepared.cmd, prepared.argv, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    encoding: "utf8",
    shell: prepared.shell,
    stdio: mode === "capture" ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (res.error) return { status: null, stdout: "", stderr: res.error.message };
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

// ---------------------------------------------------------------------------
// Probe: is Claude Code here, and does it work?
// ---------------------------------------------------------------------------

export interface ClaudeProbe {
  bin: string;
  version: string;
}

/**
 * Locate and probe the CLI with `claude --version` (verified to write nothing, so it is
 * safe under --dry-run and in `status`). No binary at all → undefined: the caller may
 * fall back to the bare copy. A binary that is present but FAILS the probe is an
 * installation error, never a licence to fall back — the user has Claude Code and it
 * is broken, which the fallback would silently paper over.
 */
export function probeClaude(configDir: string, opts: { env?: NodeJS.ProcessEnv; spawner?: ClaudeSpawner } = {}): ClaudeProbe | undefined {
  const bin = claudeBinary(opts.env ?? process.env);
  if (!bin) return undefined;
  const res = (opts.spawner ?? spawnClaude)(bin, ["--version"], configDir, "capture");
  if (res.status !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim();
    throw new Error(
      `${bin} --version failed (exit ${res.status ?? "?"})${detail ? `: ${detail}` : ""} — Claude Code is present but not working; fix it, or remove it from PATH to use the bare-copy fallback`,
    );
  }
  return { bin, version: res.stdout.trim() };
}

// ---------------------------------------------------------------------------
// Reading a registration back from disk (read-only; never spawns; never follows links)
// ---------------------------------------------------------------------------

export interface PayloadCheck {
  ok: boolean;
  problem?: string;
  manifestVersion?: string;
}

export interface InstalledEntry {
  version: string;
  scope: string;
  installPath: string;
  /** Does the record's installPath hold a plugin manifest whose version matches the record? */
  payload: PayloadCheck;
}

export interface PluginRegistration {
  configDir: string;
  /** From known_marketplaces.json — present when the marketplace is registered here. */
  marketplace?: { source: string; installLocation?: string };
  /** From installed_plugins.json — user scope first (the scope the installer writes). */
  installed: InstalledEntry[];
  /** Version directories under plugins/cache/<marketplace>/<plugin>/. */
  cacheVersions: string[];
  /** A bare `plugins/<plugin>/` copy (what `npx wicked-garden install` writes) — loaded by nothing. */
  bareCopy?: { path: string; version?: string };
  /** settings.json enabledPlugins[<pluginId>], when declared (informational). */
  enabled?: boolean;
  /** I/O, permission, symlink and containment problems — the state is UNREADABLE when non-empty. */
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.message : String(err);
}

function isUnder(real: string, root: string): boolean {
  return real === root || real.startsWith(root + sep);
}

/** A directory that really belongs to the config dir: exists, is not a symlink, resolves under root. */
function ownedDir(root: string, path: string): { ok: true } | { ok: false; missing?: true; error?: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    return errCode(err) === "ENOENT" ? { ok: false, missing: true } : { ok: false, error: `${path}: ${errCode(err)}` };
  }
  if (st.isSymbolicLink()) return { ok: false, error: `${path}: is a symlink — refusing to follow it` };
  if (!st.isDirectory()) return { ok: false, error: `${path}: not a directory` };
  try {
    if (!isUnder(realpathSync(path), root)) return { ok: false, error: `${path}: resolves outside ${root}` };
  } catch (err) {
    return { ok: false, error: `${path}: ${errCode(err)}` };
  }
  return { ok: true };
}

/** Read a JSON file without following symlinks, and only when it really lives under the config dir. */
function readOwnedJson(root: string, path: string): { value?: unknown; error?: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    return errCode(err) === "ENOENT" ? {} : { error: `${path}: ${errCode(err)}` };
  }
  if (st.isSymbolicLink()) return { error: `${path}: is a symlink — refusing to follow it` };
  if (!st.isFile()) return { error: `${path}: not a regular file` };
  try {
    if (!isUnder(realpathSync(path), root)) return { error: `${path}: resolves outside ${root}` };
  } catch (err) {
    return { error: `${path}: ${errCode(err)}` };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { error: `${path}: ${errCode(err)}` };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: `${path}: corrupt JSON` };
  }
}

/** `{ source: "github", repo }` / `{ source: "directory", path }` → "github:owner/repo" etc. */
export function describeMarketplaceSource(source: unknown): string {
  if (isRecord(source)) {
    const kind = typeof source.source === "string" ? source.source : "unknown";
    const where = [source.repo, source.path, source.url].find((v) => typeof v === "string") as string | undefined;
    return where ? `${kind}:${where}` : kind;
  }
  return typeof source === "string" ? source : "unknown";
}

/** The directory Claude Code loads the plugin from once registered. */
export function cacheRoot(configDir: string, spec: ClaudePluginSpec): string {
  return join(configDir, "plugins", "cache", spec.marketplaceName, spec.pluginName);
}

function checkPayload(root: string, configDir: string, spec: ClaudePluginSpec, installPath: string, recordVersion: string): PayloadCheck {
  if (!installPath) return { ok: false, problem: "install record has no installPath" };
  const dir = ownedDir(root, installPath);
  if (!dir.ok) return { ok: false, problem: dir.missing ? `payload dir missing: ${installPath}` : dir.error };
  // The payload must be THE cache path Claude Code (and crew) read for the recorded version —
  // a record pointing anywhere else, even at a valid-looking plugin, is not a registration.
  const expected = join(cacheRoot(configDir, spec), recordVersion);
  let atExpectedPath = false;
  try {
    atExpectedPath = realpathSync(installPath) === realpathSync(expected);
  } catch {
    atExpectedPath = false;
  }
  if (!atExpectedPath) return { ok: false, problem: `payload recorded at ${installPath} is not the expected cache path ${expected}` };
  const manifest = readOwnedJson(root, join(installPath, ".claude-plugin", "plugin.json"));
  if (manifest.error) return { ok: false, problem: manifest.error };
  if (manifest.value === undefined) return { ok: false, problem: `payload has no .claude-plugin/plugin.json: ${installPath}` };
  const manifestVersion = isRecord(manifest.value) && typeof manifest.value.version === "string" ? manifest.value.version : undefined;
  if (manifestVersion !== recordVersion) {
    return { ok: false, manifestVersion, problem: `payload plugin.json version ${manifestVersion ?? "(missing)"} does not match the install record (${recordVersion})` };
  }
  return { ok: true, manifestVersion };
}

export function readRegistration(configDir: string, spec: ClaudePluginSpec): PluginRegistration {
  const reg: PluginRegistration = { configDir, installed: [], cacheVersions: [], errors: [] };

  let root: string;
  try {
    root = realpathSync(configDir);
  } catch (err) {
    if (errCode(err) !== "ENOENT") reg.errors.push(`${configDir}: ${errCode(err)}`);
    return reg; // no config dir ⇒ nothing registered
  }
  const pluginsDir = join(configDir, "plugins");
  const plugins = ownedDir(root, pluginsDir);
  if (!plugins.ok) {
    if (plugins.error) reg.errors.push(plugins.error);
    return reg; // no plugins dir ⇒ nothing registered
  }

  const known = readOwnedJson(root, join(pluginsDir, "known_marketplaces.json"));
  if (known.error) reg.errors.push(known.error);
  else if (isRecord(known.value) && isRecord(known.value[spec.marketplaceName])) {
    const entry = known.value[spec.marketplaceName] as Record<string, unknown>;
    reg.marketplace = {
      source: describeMarketplaceSource(entry.source),
      installLocation: typeof entry.installLocation === "string" ? entry.installLocation : undefined,
    };
  }

  const installed = readOwnedJson(root, join(pluginsDir, "installed_plugins.json"));
  if (installed.error) reg.errors.push(installed.error);
  else if (isRecord(installed.value)) {
    // v2 nests the map under `plugins` and holds one entry per scope in an array; the
    // v1 file keyed plugins at the top level with a single object. Accept both.
    const map = isRecord(installed.value.plugins) ? installed.value.plugins : installed.value;
    const raw = map[spec.pluginId];
    const entries = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    for (const e of entries) {
      if (!isRecord(e)) continue;
      const version = typeof e.version === "string" ? e.version : "unknown";
      const installPath = typeof e.installPath === "string" ? e.installPath : "";
      reg.installed.push({
        version,
        scope: typeof e.scope === "string" ? e.scope : "user",
        installPath,
        payload: checkPayload(root, configDir, spec, installPath, version),
      });
    }
    reg.installed.sort((a, b) => Number(b.scope === "user") - Number(a.scope === "user"));
  }

  const cache = ownedDir(root, cacheRoot(configDir, spec));
  if (cache.ok) {
    try {
      reg.cacheVersions = readdirSync(cacheRoot(configDir, spec), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => d.name)
        .sort();
    } catch (err) {
      reg.errors.push(`${cacheRoot(configDir, spec)}: ${errCode(err)}`);
    }
  } else if (cache.error) {
    reg.errors.push(cache.error);
  }

  const bareDir = join(pluginsDir, spec.pluginName);
  const bare = ownedDir(root, bareDir);
  if (bare.ok) {
    const manifest = readOwnedJson(root, join(bareDir, ".claude-plugin", "plugin.json"));
    if (manifest.error) reg.errors.push(manifest.error);
    if (manifest.value !== undefined || manifest.error) {
      reg.bareCopy = {
        path: bareDir,
        version: isRecord(manifest.value) && typeof manifest.value.version === "string" ? manifest.value.version : undefined,
      };
    }
  } else if (bare.error) {
    reg.errors.push(bare.error);
  }

  // Informational: Claude Code records the enable switch in settings.json. A corrupt or
  // unreadable settings.json is the user's problem to notice elsewhere, not a status error.
  const settings = readOwnedJson(root, join(configDir, "settings.json"));
  if (isRecord(settings.value) && isRecord(settings.value.enabledPlugins)) {
    const flag = settings.value.enabledPlugins[spec.pluginId];
    if (typeof flag === "boolean") reg.enabled = flag;
  }

  return reg;
}

// ---------------------------------------------------------------------------
// The verdict — one definition for install, status and detection
// ---------------------------------------------------------------------------

export type RegistrationState = "registered" | "partial" | "copy-only" | "absent" | "unreadable";

export interface RegistrationVerdict {
  state: RegistrationState;
  /** What is missing (`partial`) or what could not be read (`unreadable`). */
  problems: string[];
}

/**
 * REGISTERED requires all three: the marketplace entry, the install record, and the
 * payload — at the expected cache path plugins/cache/<marketplace>/<plugin>/<version>/
 * for the recorded version, holding a plugin.json whose version matches the record. A
 * record with anything missing is PARTIAL (what is missing is named); a bare
 * plugins/<plugin>/ copy with no record is COPY-ONLY; an I/O, permission, symlink or
 * containment problem makes the state UNREADABLE — reported as an error, never as
 * "not installed".
 */
export function registrationVerdict(reg: PluginRegistration): RegistrationVerdict {
  if (reg.errors.length > 0) return { state: "unreadable", problems: [...reg.errors] };
  if (reg.installed.length === 0) return { state: reg.bareCopy ? "copy-only" : "absent", problems: [] };
  const problems: string[] = [];
  if (!reg.marketplace) problems.push("marketplace entry missing from known_marketplaces.json");
  if (!reg.installed.some((e) => e.payload.ok)) {
    for (const e of reg.installed) problems.push(e.payload.problem ?? "payload problem");
  }
  return { state: problems.length > 0 ? "partial" : "registered", problems };
}

export function describeVerdict(verdict: RegistrationVerdict): string {
  switch (verdict.state) {
    case "registered": return "registered";
    case "partial": return `partially registered (${verdict.problems.join("; ")})`;
    case "copy-only": return "copy only (unregistered)";
    case "absent": return "not installed";
    case "unreadable": return `unreadable (${verdict.problems.join("; ")})`;
  }
}

// ---------------------------------------------------------------------------
// Marketplace source: published GitHub marketplace, or a local checkout
// ---------------------------------------------------------------------------

/** `<root>/<marketplace>` or `<root>` when it holds a marketplace manifest; else undefined. */
export function localMarketplaceUnder(spec: ClaudePluginSpec, root: string): string | undefined {
  const base = resolve(root);
  for (const candidate of [join(base, spec.marketplaceName), base]) {
    if (existsSync(join(candidate, ".claude-plugin", "marketplace.json"))) return candidate;
  }
  return undefined;
}

/**
 * An explicit `--source-root <dir>` registers a LOCAL checkout as the marketplace. It
 * fails fast (also under --dry-run) when the root holds no manifest — a wrong root must
 * not silently fall back to GitHub.
 */
export function resolveMarketplaceSource(spec: ClaudePluginSpec, sourceRoot?: string): string {
  if (!sourceRoot) return spec.source;
  const local = localMarketplaceUnder(spec, sourceRoot);
  if (local) return local;
  const base = resolve(sourceRoot);
  throw new Error(`--source-root ${sourceRoot}: no .claude-plugin/marketplace.json under ${join(base, spec.marketplaceName)} or ${base}`);
}

// ---------------------------------------------------------------------------
// The plan — shared by the dry run (printed) and the live run (executed)
// ---------------------------------------------------------------------------

export interface PlannedCommand {
  args: string[];
  /** The command as the user would type it, CLAUDE_CONFIG_DIR included. */
  render: string;
  /** Why it runs, from the probe result. */
  because: string;
}

export interface DirPlan {
  dir: string;
  /** What was read from disk to decide, one line each. */
  probes: string[];
  commands: PlannedCommand[];
  registration: PluginRegistration;
}

/**
 * Decide, from the on-disk state of one config dir, exactly which Claude Code commands
 * bring the plugin to "registered": `marketplace add` only when the marketplace is
 * absent (one already registered from another source, e.g. a local checkout, is kept);
 * `plugin update` when a healthy install record exists, `plugin install` otherwise
 * (including a partial record, which install repairs). An unreadable state is an error.
 */
export function planForDir(dir: string, spec: ClaudePluginSpec, source: string): DirPlan {
  const registration = readRegistration(dir, spec);
  if (registration.errors.length > 0) {
    throw new Error(`${dir}: registration state unreadable — ${registration.errors.join("; ")}`);
  }
  const current = registration.installed[0];
  const probes = [
    `${join(dir, "plugins", "known_marketplaces.json")} → marketplace ${spec.marketplaceName}: ${registration.marketplace ? `registered (${registration.marketplace.source})` : "not registered"}`,
    `${join(dir, "plugins", "installed_plugins.json")} → ${spec.pluginId}: ${current ? `${current.version} (${current.scope})${current.payload.ok ? "" : `; ${current.payload.problem}`}` : "not installed"}`,
  ];
  const prefix = `CLAUDE_CONFIG_DIR=${dir} claude`;
  const commands: PlannedCommand[] = [];
  if (!registration.marketplace) {
    commands.push({ args: ["plugin", "marketplace", "add", source], render: `${prefix} plugin marketplace add ${source}`, because: "marketplace not registered" });
  }
  if (current && current.payload.ok) {
    commands.push({ args: ["plugin", "update", spec.pluginId], render: `${prefix} plugin update ${spec.pluginId}`, because: `installed ${current.version}` });
  } else {
    commands.push({
      args: ["plugin", "install", spec.pluginId],
      render: `${prefix} plugin install ${spec.pluginId}`,
      because: current ? `install record present but ${current.payload.problem}` : "not installed",
    });
  }
  return { dir, probes, commands, registration };
}

export interface PlanOptions {
  configDirs: ClaudeConfigDirs;
  /** Marketplace source (published `owner/repo`, or a local checkout path). */
  source: string;
  env?: NodeJS.ProcessEnv;
  spawner?: ClaudeSpawner;
}

export interface PlanOutcome {
  claudeDetected: boolean;
  /** `probe: …` lines and the commands that would run, ready to print. */
  lines: string[];
  plans: DirPlan[];
}

/**
 * The dry run: the same probes the live run makes (`claude --version`, on-disk state)
 * and exactly the commands it would execute — nothing else runs. A present-but-broken
 * Claude Code throws, as it would live.
 */
export function planClaudePlugin(spec: ClaudePluginSpec, opts: PlanOptions): PlanOutcome {
  const { dirs, origin } = opts.configDirs;
  const probe = probeClaude(dirs[0], opts);
  if (!probe) return { claudeDetected: false, lines: [], plans: [] };
  const lines: string[] = [
    `probe: ${probe.bin} --version → ${probe.version}`,
    `Claude Code detected; would register ${spec.pluginId} in ${dirs.length} config dir(s) from ${describeOrigin(origin)}:`,
  ];
  const plans: DirPlan[] = [];
  for (const dir of dirs) {
    const plan = planForDir(dir, spec, opts.source);
    plans.push(plan);
    lines.push(dir);
    for (const p of plan.probes) lines.push(`probe:   ${p}`);
    for (const c of plan.commands) lines.push(`  ${c.render}    (${c.because})`);
    lines.push(`  → payload ${cacheRoot(dir, spec)}/<version>`);
    if (plan.registration.bareCopy) lines.push(`  note: bare copy at ${plan.registration.bareCopy.path} is loaded by nothing (copy only, unregistered)`);
  }
  return { claudeDetected: true, lines, plans };
}

export interface RegisterOptions extends PlanOptions {
  log: (line: string) => void;
}

export type RegisterResult =
  | { claudeDetected: false }
  | { claudeDetected: true; version: string; versions: Record<string, string>; ran: Record<string, string[]> };

/**
 * The live run: probe, then per config dir execute exactly the planned commands with
 * CLAUDE_CONFIG_DIR pinned, then re-derive the registration from disk — Claude Code
 * exiting 0 is a claim; a `registered` verdict is the evidence. Throws on any failure.
 */
export function registerClaudePlugin(spec: ClaudePluginSpec, opts: RegisterOptions): RegisterResult {
  const spawner = opts.spawner ?? spawnClaude;
  const { dirs, origin } = opts.configDirs;

  const probe = probeClaude(dirs[0], opts);
  if (!probe) return { claudeDetected: false };
  opts.log(`  probe: ${probe.bin} --version → ${probe.version}`);
  opts.log(`  registering ${spec.pluginId} in ${dirs.length} config dir(s) from ${describeOrigin(origin)}`);

  const versions: Record<string, string> = {};
  const ran: Record<string, string[]> = {};
  for (const dir of dirs) {
    const plan = planForDir(dir, spec, opts.source);
    opts.log(`  ${dir}`);
    for (const p of plan.probes) opts.log(`    probe: ${p}`);
    for (const c of plan.commands) {
      opts.log(`    ${c.render}    (${c.because})`);
      const res = spawner(probe.bin, c.args, dir, "inherit");
      if (res.status !== 0) {
        const detail = res.stderr.trim() || res.stdout.trim();
        throw new Error(`${c.render} failed (exit ${res.status ?? "?"})${detail ? `: ${detail}` : ""}`);
      }
    }
    ran[dir] = plan.commands.map((c) => c.render);

    const reg = readRegistration(dir, spec);
    const verdict = registrationVerdict(reg);
    if (verdict.state !== "registered") {
      throw new Error(`${spec.pluginId}: claude reported success but the registration in ${dir} is ${describeVerdict(verdict)} — Claude Code would not load it`);
    }
    const { version, installPath } = reg.installed[0];
    versions[dir] = version;
    opts.log(`    registered ${spec.pluginId} ${version} → ${installPath}`);
  }

  return { claudeDetected: true, version: probe.version, versions, ran };
}
