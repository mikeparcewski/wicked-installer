import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
// each active config dir, and reads the resulting registration back from disk.
//
// Reading is deliberately file-based: even `claude plugin list` initialises
// <configDir>/.claude.json (and a backup) as a side effect, so `status` must never
// spawn the CLI, and a `--dry-run` must spawn nothing at all (see planClaudePlugin).
//
// Config-dir resolution mirrors install-claude.ts resolveTargets exactly:
// --claude-home flags → CLAUDE_CONFIG_DIR (exclusive when set) → ~/.claude.
// ---------------------------------------------------------------------------

export interface ClaudePluginSpec {
  /** `<plugin>@<marketplace>` — the id `claude plugin install|update|list` uses. */
  pluginId: string;
  pluginName: string;
  marketplaceName: string;
  /** What `claude plugin marketplace add` receives: GitHub `owner/repo`, a URL, or a local path. */
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

export function resolveClaudeConfigDirs(
  opts: { homeFlags?: string[]; env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform } = {},
): ClaudeConfigDirs {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  // 1. Explicit flags win as the full set.
  const flags = (opts.homeFlags ?? []).map((d) => resolve(expandHome(d, home)));
  if (flags.length > 0) return { dirs: [...new Set(flags)], origin: "flag" };

  // 2. CLAUDE_CONFIG_DIR is authoritative and exclusive when set.
  const raw = env.CLAUDE_CONFIG_DIR;
  if (raw && raw.trim()) {
    const dirs = splitConfigDirValue(raw, opts.platform).map((d) => resolve(expandHome(d, home)));
    if (dirs.length > 0) return { dirs: [...new Set(dirs)], origin: "env" };
  }

  // 3. Only ~/.claude is a config root Claude Code reads by default.
  return { dirs: [resolve(home, ".claude")], origin: "default" };
}

// ---------------------------------------------------------------------------
// Locating the Claude Code CLI without spawning (a dry run must spawn nothing)
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

/**
 * Run the Claude Code CLI once with CLAUDE_CONFIG_DIR=<configDir>. `capture` pipes
 * stdout/stderr (for `--json` queries); `inherit` streams them so marketplace clones
 * and install progress — and any consent prompt Claude Code raises — reach the user.
 * Never relies on a shebang (Windows): a .js/.mjs binary is run through node.
 */
export const spawnClaude: ClaudeSpawner = (bin, args, configDir, mode) => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  let cmd = bin;
  let argv = args;
  let shell = false;
  if (/\.(mjs|cjs|js)$/i.test(bin)) {
    cmd = process.execPath;
    argv = [bin, ...args];
  } else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    shell = true;
    cmd = winQuote(bin);
    argv = args.map(winQuote);
  }
  const res = spawnSync(cmd, argv, {
    env,
    encoding: "utf8",
    shell,
    stdio: mode === "capture" ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (res.error) return { status: null, stdout: "", stderr: res.error.message };
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

// ---------------------------------------------------------------------------
// Reading a registration back from disk (read-only; never spawns)
// ---------------------------------------------------------------------------

export interface InstalledEntry {
  version: string;
  scope: string;
  installPath: string;
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
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(path: string): { value?: unknown; error?: string } {
  if (!existsSync(path)) return {};
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (err) {
    return { error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
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

export function readRegistration(configDir: string, spec: ClaudePluginSpec): PluginRegistration {
  const reg: PluginRegistration = { configDir, installed: [], cacheVersions: [], warnings: [] };
  const pluginsDir = join(configDir, "plugins");

  const known = readJsonFile(join(pluginsDir, "known_marketplaces.json"));
  if (known.error) reg.warnings.push(`corrupt ${known.error}`);
  else if (isRecord(known.value) && isRecord(known.value[spec.marketplaceName])) {
    const entry = known.value[spec.marketplaceName] as Record<string, unknown>;
    reg.marketplace = {
      source: describeMarketplaceSource(entry.source),
      installLocation: typeof entry.installLocation === "string" ? entry.installLocation : undefined,
    };
  }

  const installed = readJsonFile(join(pluginsDir, "installed_plugins.json"));
  if (installed.error) reg.warnings.push(`corrupt ${installed.error}`);
  else if (isRecord(installed.value)) {
    // v2 nests the map under `plugins` and holds one entry per scope in an array; the
    // v1 file keyed plugins at the top level with a single object. Accept both.
    const plugins = isRecord(installed.value.plugins) ? installed.value.plugins : installed.value;
    const raw = plugins[spec.pluginId];
    const entries = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    for (const e of entries) {
      if (!isRecord(e)) continue;
      reg.installed.push({
        version: typeof e.version === "string" ? e.version : "unknown",
        scope: typeof e.scope === "string" ? e.scope : "user",
        installPath: typeof e.installPath === "string" ? e.installPath : "",
      });
    }
    reg.installed.sort((a, b) => Number(b.scope === "user") - Number(a.scope === "user"));
  }

  try {
    reg.cacheVersions = readdirSync(join(pluginsDir, "cache", spec.marketplaceName, spec.pluginName), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    /* no cache dir */
  }

  const barePath = join(pluginsDir, spec.pluginName);
  const bareManifest = readJsonFile(join(barePath, ".claude-plugin", "plugin.json"));
  if (bareManifest.value !== undefined || bareManifest.error) {
    reg.bareCopy = {
      path: barePath,
      version: isRecord(bareManifest.value) && typeof bareManifest.value.version === "string" ? bareManifest.value.version : undefined,
    };
  }
  return reg;
}

/** The directory Claude Code loads the plugin from once registered. */
export function cacheRoot(configDir: string, spec: ClaudePluginSpec): string {
  return join(configDir, "plugins", "cache", spec.marketplaceName, spec.pluginName);
}

// ---------------------------------------------------------------------------
// Marketplace source: published GitHub marketplace, or a local checkout
// ---------------------------------------------------------------------------

/**
 * `--source-root <dir>` registers a LOCAL checkout as the marketplace: `<dir>/<marketplace>`
 * when that holds `.claude-plugin/marketplace.json`, else `<dir>` itself. Fails fast (also
 * under --dry-run) when neither does — a wrong root must not silently fall back to GitHub.
 */
export function resolveMarketplaceSource(spec: ClaudePluginSpec, sourceRoot?: string): string {
  if (!sourceRoot) return spec.source;
  const root = resolve(sourceRoot);
  const candidates = [join(root, spec.marketplaceName), root];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, ".claude-plugin", "marketplace.json"))) return candidate;
  }
  throw new Error(`--source-root ${sourceRoot}: no .claude-plugin/marketplace.json under ${candidates.join(" or ")}`);
}

// ---------------------------------------------------------------------------
// Dry-run plan (zero spawns) and live registration
// ---------------------------------------------------------------------------

export interface PlanOutcome {
  claudeDetected: boolean;
  claudeBin?: string;
  lines: string[];
}

/**
 * The exact plan a live run would execute, derived from PATH + on-disk state only.
 * Spawns nothing — not even `claude --version` — so `--dry-run` is provably dry.
 */
export function planClaudePlugin(
  spec: ClaudePluginSpec,
  opts: { configDirs: ClaudeConfigDirs; sourceRoot?: string; env?: NodeJS.ProcessEnv },
): PlanOutcome {
  const bin = claudeBinary(opts.env ?? process.env);
  if (!bin) return { claudeDetected: false, lines: [] };
  const source = resolveMarketplaceSource(spec, opts.sourceRoot);
  const { dirs, origin } = opts.configDirs;
  const lines: string[] = [
    `Claude Code detected (${bin}); would register ${spec.pluginId} in ${dirs.length} config dir(s) from ${describeOrigin(origin)}:`,
  ];
  for (const dir of dirs) {
    const reg = readRegistration(dir, spec);
    const prefix = `CLAUDE_CONFIG_DIR=${dir} claude plugin`;
    lines.push(dir);
    lines.push(`  ${prefix} marketplace list --json`);
    lines.push(
      `  ${prefix} marketplace add ${source}    ` +
        (reg.marketplace ? `(skip: marketplace already registered, ${reg.marketplace.source})` : "(marketplace not registered on disk)"),
    );
    lines.push(`  ${prefix} list --json`);
    const current = reg.installed[0];
    lines.push(
      current
        ? `  ${prefix} update ${spec.pluginId}    (installed ${current.version})`
        : `  ${prefix} install ${spec.pluginId}    (not installed)`,
    );
    lines.push(`  → ${cacheRoot(dir, spec)}/<version>`);
    if (reg.bareCopy) lines.push(`  note: bare copy at ${reg.bareCopy.path} is loaded by nothing (copy only, unregistered)`);
  }
  return { claudeDetected: true, claudeBin: bin, lines };
}

export interface RegisterOptions {
  configDirs: ClaudeConfigDirs;
  sourceRoot?: string;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  spawner?: ClaudeSpawner;
}

export type RegisterResult =
  | { claudeDetected: false; reason: string }
  | { claudeDetected: true; versions: Record<string, string> };

function parseJsonArray(text: string, what: string): unknown[] {
  const start = text.indexOf("[");
  if (start === -1) throw new Error(`${what}: expected a JSON array, got: ${text.trim().slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start)) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${what}: expected a JSON array`);
  return parsed;
}

/** A `claude plugin marketplace list --json` row: `{ name, source, path|repo|url, installLocation }`. */
function describeListedMarketplace(row: Record<string, unknown>): string {
  const kind = typeof row.source === "string" ? row.source : "unknown";
  const where = [row.repo, row.path, row.url].find((v) => typeof v === "string") as string | undefined;
  return where ? `${kind}:${where}` : kind;
}

/**
 * Register the plugin in every target config dir through Claude Code's own CLI:
 * `marketplace list` → `marketplace add` only when absent (a marketplace already
 * registered from another source is kept as-is) → `plugin list` → `plugin install`
 * or `plugin update`. Every call carries CLAUDE_CONFIG_DIR=<target>. Verifies from
 * disk that the cache payload exists afterwards. Throws on any CLI failure.
 */
export function registerClaudePlugin(spec: ClaudePluginSpec, opts: RegisterOptions): RegisterResult {
  const env = opts.env ?? process.env;
  const spawner = opts.spawner ?? spawnClaude;
  const { dirs, origin } = opts.configDirs;

  const bin = claudeBinary(env);
  if (!bin) return { claudeDetected: false, reason: "claude is not on PATH" };
  const probe = spawner(bin, ["--version"], dirs[0], "capture");
  if (probe.status !== 0) {
    return { claudeDetected: false, reason: `${bin} --version failed${probe.stderr.trim() ? `: ${probe.stderr.trim()}` : ""}` };
  }

  const source = resolveMarketplaceSource(spec, opts.sourceRoot);
  const run = (args: string[], dir: string, mode: "capture" | "inherit"): string => {
    const res = spawner(bin, args, dir, mode);
    if (res.status !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim();
      throw new Error(`CLAUDE_CONFIG_DIR=${dir} claude ${args.join(" ")} failed (exit ${res.status ?? "?"})${detail ? `: ${detail}` : ""}`);
    }
    return res.stdout;
  };

  opts.log(`  Claude Code ${probe.stdout.trim()} at ${bin}; registering ${spec.pluginId} in ${dirs.length} config dir(s) from ${describeOrigin(origin)}`);
  const versions: Record<string, string> = {};

  for (const dir of dirs) {
    opts.log(`  ${dir}`);

    const marketplaces = parseJsonArray(run(["plugin", "marketplace", "list", "--json"], dir, "capture"), "claude plugin marketplace list --json");
    const known = marketplaces.find((m): m is Record<string, unknown> => isRecord(m) && m.name === spec.marketplaceName);
    if (known) {
      opts.log(`    marketplace ${spec.marketplaceName} already registered (${describeListedMarketplace(known)}); keeping it`);
    } else {
      opts.log(`    claude plugin marketplace add ${source}`);
      run(["plugin", "marketplace", "add", source], dir, "inherit");
    }

    const plugins = parseJsonArray(run(["plugin", "list", "--json"], dir, "capture"), "claude plugin list --json");
    const installed = plugins.find((p): p is Record<string, unknown> => isRecord(p) && (p.id === spec.pluginId || p.name === spec.pluginId));
    if (installed) {
      opts.log(`    claude plugin update ${spec.pluginId}    (installed ${typeof installed.version === "string" ? installed.version : "unknown"})`);
      run(["plugin", "update", spec.pluginId], dir, "inherit");
    } else {
      opts.log(`    claude plugin install ${spec.pluginId}`);
      run(["plugin", "install", spec.pluginId], dir, "inherit");
    }

    // Re-derive from disk: Claude Code exiting 0 is a claim; the cache payload is the evidence.
    const reg = readRegistration(dir, spec);
    const version = reg.installed[0]?.version;
    const cacheDir = version ? join(cacheRoot(dir, spec), version) : undefined;
    if (!version || !cacheDir || !existsSync(cacheDir)) {
      throw new Error(`${spec.pluginId}: claude reported success but ${cacheRoot(dir, spec)}/<version> is missing — Claude Code would not load it`);
    }
    versions[dir] = version;
    opts.log(`    registered ${spec.pluginId} ${version} → ${cacheDir}`);
  }

  return { claudeDetected: true, versions };
}
