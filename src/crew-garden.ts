/**
 * What wicked-crew's daemon will SEE here (first-run B1/B2/B3/C5).
 *
 * The installer can deliver garden to Codex, OpenCode or the npm prefix while Claude Code's
 * registration fails or is not selected, and it puts estate (and astral's installer puts uv) in
 * ~/.local/bin. Crew's daemon then found no garden and refused every launch, yet the readiness
 * check said "ready wicked-crew". This module answers the questions crew asks at boot, its way:
 *
 * - crew's PATH: `wicked-crew serve` appends $XDG_BIN_HOME, ~/.local/bin and ~/.cargo/bin (when not
 *   already listed) to its own PATH, so uv, wicked-estate and the garden launcher are looked up there.
 * - crew's garden resolution order (first hit wins):
 *   1. WICKED_CREW_SKILLS_SOURCE, as spelled (crew neither trims nor expands `~`)
 *   2. Claude Code's marketplace cache <config dir>/plugins/cache/wicked-garden/wicked-garden/<version>
 *      for each config dir crew walks: every CLAUDE_CONFIG_DIR entry, then ~/.claude
 *   3. the older installer copy <config dir>/plugins/wicked-garden, same dirs
 *   4. the npm package: the realpath of the `wicked-garden` launcher on crew's PATH, else the
 *      wicked-garden package beside wicked-crew's own global install
 *   5. Codex's plugin cache <CODEX_HOME|~/.codex>/plugins/cache/<marketplace>/wicked-garden/<version>
 *   A candidate counts only when `.claude-plugin/plugin.json` is a regular file (no link) that parses
 *   with a non-empty string `version`; a cache entry's directory name must equal that version.
 *   OpenCode / Pi / Antigravity skill copies are not a source for crew: they carry skills only.
 * Crew also compares the version with its own minimum, which lives in crew; the found version is
 * reported so a stale garden is visible, but the floor is not judged here.
 * Filesystem probes only — nothing is spawned.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { probeOnPath } from "./claude-plugin.js";

export interface CrewGardenHit {
  path: string;
  /** Which of crew's sources matched, in words. */
  source: string;
  version: string;
}

/** The home crew's daemon would use: the checked environment's (tests and sandboxes set HOME), else this user's. */
export function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
}

/** `env` with PATH as `wicked-crew serve` extends it at boot (its own dirs appended, the user's PATH first). */
export function crewEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const sep = platform === "win32" ? ";" : ":";
  const key = env.PATH === undefined && env.Path !== undefined ? "Path" : "PATH";
  const dirs = (env[key] ?? "").split(sep).filter(Boolean);
  const home = homeOf(env, platform);
  for (const extra of [env.XDG_BIN_HOME, join(home, ".local", "bin"), join(home, ".cargo", "bin")]) {
    if (extra && !dirs.includes(extra)) dirs.push(extra);
  }
  return { ...env, [key]: dirs.join(sep) };
}

/** The manifest version of a plugin root, or undefined when it is not one crew would accept. */
function manifestVersion(dir: string): string | undefined {
  try {
    const cp = join(dir, ".claude-plugin");
    if (!lstatSync(cp).isDirectory()) return undefined;
    const manifest = join(cp, "plugin.json");
    if (!lstatSync(manifest).isFile()) return undefined; // lstat: a symlinked manifest is refused by crew
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : undefined;
  } catch {
    return undefined;
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)).sort();
  } catch {
    return [];
  }
}

/** A versioned cache dir: <cache>/<version> whose manifest version equals its name. */
/** Highest X.Y.Z first, as crew picks (only the reported version depends on it; any valid dir is "found"). */
function byVersionDesc(a: string, b: string): number {
  const pa = basename(a).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = basename(b).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}

function cacheHit(cache: string): { path: string; version: string } | undefined {
  for (const dir of subdirs(cache).sort(byVersionDesc)) {
    const version = manifestVersion(dir);
    if (version !== undefined && version === basename(dir)) return { path: dir, version };
  }
  return undefined;
}

/** Walk up from `start` to the directory whose package.json names `pkg`. */
function packageRootOf(start: string, pkg: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === pkg) return dir;
      } catch {
        // unreadable manifest: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function launcherPackage(bin: string, pkg: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const probe = probeOnPath(bin, env, platform);
  if (probe.state !== "found") return undefined;
  let real: string;
  try {
    real = realpathSync(probe.path);
  } catch {
    return undefined;
  }
  const direct = packageRootOf(dirname(real), pkg);
  if (direct) return direct;
  // Windows npm shims (wicked-garden.cmd) are files beside node_modules, not symlinks into it.
  const beside = join(dirname(probe.path), "node_modules", pkg);
  return existsSync(beside) ? beside : undefined;
}

/** The Claude Code config dirs crew walks, in order: each CLAUDE_CONFIG_DIR entry as listed, then ~/.claude. */
export function crewClaudeConfigDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...(env.CLAUDE_CONFIG_DIR ?? "").split(platform === "win32" ? ";" : ":"), join(homeOf(env, platform), ".claude")]) {
    if (dir === "") continue;
    const key = resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

export function findGardenForCrew(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CrewGardenHit | undefined {
  const home = homeOf(env, platform);
  const override = env.WICKED_CREW_SKILLS_SOURCE;
  if (override) {
    // An explicit override is the only source crew reads (and crew does not judge its version floor).
    const version = manifestVersion(resolve(override));
    return version !== undefined ? { path: resolve(override), source: "WICKED_CREW_SKILLS_SOURCE", version } : undefined;
  }
  const configDirs = crewClaudeConfigDirs(env, platform);
  for (const cfg of configDirs) {
    const hit = cacheHit(join(cfg, "plugins", "cache", "wicked-garden", "wicked-garden"));
    if (hit) return { ...hit, source: "Claude Code plugin cache" };
  }
  for (const cfg of configDirs) {
    const dir = join(cfg, "plugins", "wicked-garden");
    const version = manifestVersion(dir);
    if (version !== undefined) return { path: dir, source: "Claude Code plugin copy", version };
  }

  const path = crewEnv(env, platform);
  const fromLauncher = launcherPackage("wicked-garden", "wicked-garden", path, platform);
  const launcherVersion = fromLauncher ? manifestVersion(fromLauncher) : undefined;
  if (fromLauncher && launcherVersion !== undefined) return { path: fromLauncher, source: "npm package (wicked-garden on PATH)", version: launcherVersion };
  const crewPkg = launcherPackage("wicked-crew", "wicked-crew", path, platform);
  if (crewPkg) {
    const beside = join(dirname(crewPkg), "wicked-garden");
    const version = manifestVersion(beside);
    if (version !== undefined) return { path: beside, source: "npm package beside wicked-crew", version };
  }

  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
  for (const marketplace of subdirs(join(codexHome, "plugins", "cache"))) {
    const hit = cacheHit(join(marketplace, "wicked-garden"));
    if (hit) return { ...hit, source: "Codex plugin cache" };
  }
  return undefined;
}

/**
 * Garden delivered only as OpenCode / Pi / Antigravity skill copies (or a failed Claude Code
 * registration) is invisible to crew, which then refuses every job (first-run B3). When crew and
 * garden are both being installed and crew would find no garden, install the wicked-garden npm
 * package globally — crew finds it there on every platform (source 4). Returns a line to print.
 */
export function ensureGardenForCrew(opts: {
  productIds: string[];
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[]) => { status: number | null; error?: string };
}): { action: "not-needed" | "present" | "planned" | "installed" | "failed"; message: string } {
  if (!opts.productIds.includes("wicked-crew") || !opts.productIds.includes("wicked-garden")) return { action: "not-needed", message: "" };
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (findGardenForCrew(env, platform)) return { action: "present", message: "" };
  if (opts.dryRun) return { action: "planned", message: "dry-run: after install, if crew finds no wicked-garden plugin (no Claude Code or Codex registration): npm install -g wicked-garden" };
  const run = opts.run ?? ((cmd: string, args: string[]) => {
    // npm is npm.cmd on Windows: a shell resolves it (fixed args, nothing user-supplied).
    const r = spawnSync(cmd, args, { env, stdio: "inherit", shell: platform === "win32" });
    return { status: r.status, error: r.error?.message };
  });
  const r = run("npm", ["install", "-g", "wicked-garden"]);
  const found = r.status === 0 ? findGardenForCrew(env, platform) : undefined;
  return found
    ? { action: "installed", message: `crew found no wicked-garden plugin, so the wicked-garden npm package was installed globally (${found.path})` }
    : { action: "failed", message: `crew finds no wicked-garden plugin, and \`npm install -g wicked-garden\` did not fix it (${r.error ?? `exit ${r.status ?? "?"}`}); run it yourself` };
}
