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
 * Crew also refuses a garden below its own minimum (REQUIRED_GARDEN_VERSION): `ensureGardenForCrew`
 * judges that floor. The discovery functions here are filesystem probes only — nothing is spawned.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { probeOnPath, renderClaudeCommand } from "./claude-plugin.js";

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

/**
 * The first wicked-crew that looks in the installer's locations (its PATH extension and garden
 * tiers 4-5, first-run B3). An older crew found on PATH is judged by its own, narrower rules.
 */
export const CREW_FINDS_INSTALLER_LOCATIONS = "0.18.0";

function atLeast(found: string, min: string): boolean {
  const a = found.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const b = min.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The version of the wicked-crew on PATH (its package.json), or undefined when there is none to read. */
export function installedCrewVersion(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pkg = launcherPackage("wicked-crew", "wicked-crew", env, platform);
  if (!pkg) return undefined;
  try {
    const v = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does the crew that will run here look in ~/.local/bin and the npm / Codex garden locations? No
 * crew on PATH yet ⇒ yes: the install puts the latest crew there.
 */
export function crewKnowsInstallerLocations(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const v = installedCrewVersion(env, platform);
  return v === undefined || atLeast(v, CREW_FINDS_INSTALLER_LOCATIONS);
}

/** `env` with PATH as `wicked-crew serve` extends it at boot (its own dirs appended, the user's PATH first); unchanged for an older crew. */
export function crewEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (!crewKnowsInstallerLocations(env, platform)) return env;
  const sep = platform === "win32" ? ";" : ":";
  const key = env.PATH === undefined && env.Path !== undefined ? "Path" : "PATH";
  const dirs = (env[key] ?? "").split(sep).filter(Boolean);
  const home = homeOf(env, platform);
  for (const extra of [env.XDG_BIN_HOME, join(home, ".local", "bin"), join(home, ".cargo", "bin")]) {
    if (extra && !dirs.includes(extra)) dirs.push(extra);
  }
  return { ...env, [key]: dirs.join(sep) };
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The manifest version of a plugin root, undefined when it is not one crew would accept, or
 * LINK when crew REFUSES the whole discovery (a symlinked `.claude-plugin/` or `plugin.json`).
 */
const LINK: unique symbol = Symbol("symlinked manifest");
type Linked = typeof LINK;

function manifestVersion(dir: string): string | Linked | undefined {
  const cp = join(dir, ".claude-plugin");
  const manifest = join(cp, "plugin.json");
  if (isLink(cp) || isLink(manifest)) return LINK;
  try {
    if (!lstatSync(cp).isDirectory() || !lstatSync(manifest).isFile()) return undefined;
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

/** SemVer 2.0.0 (semver.org): crew ignores a cache entry whose name is not one. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Highest X.Y.Z first (only the REPORTED version depends on this order; prereleases are not ranked). */
function byVersionDesc(a: string, b: string): number {
  const pa = basename(a).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = basename(b).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}

/** No segment below `root` is a link (crew walks below a canonical root without following links). */
function linkFreeBelow(root: string, segments: string[]): string | undefined {
  let p = root;
  for (const seg of segments) {
    p = join(p, seg);
    if (isLink(p)) return undefined;
  }
  return p;
}

/**
 * A marketplace cache: every SemVer-named entry is judged, as crew does; a symlinked manifest in ANY
 * of them makes crew refuse discovery (LINK). The pick: an entry whose manifest version equals its name.
 */
function cacheHit(root: string, segments: string[]): { path: string; version: string } | Linked | undefined {
  const cache = linkFreeBelow(root, segments);
  if (!cache) return undefined;
  let pick: { path: string; version: string } | undefined;
  for (const dir of subdirs(cache).sort(byVersionDesc)) {
    if (!SEMVER.test(basename(dir)) || isLink(dir)) continue;
    const version = manifestVersion(dir);
    if (version === LINK) return LINK;
    if (!pick && version !== undefined && version === basename(dir)) pick = { path: dir, version };
  }
  return pick;
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

/** The Claude Code config dirs crew walks, in order: each CLAUDE_CONFIG_DIR entry as listed, then ~/.claude — each by its real path, once. */
export function crewClaudeConfigRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  for (const dir of [...(env.CLAUDE_CONFIG_DIR ?? "").split(platform === "win32" ? ";" : ":"), join(homeOf(env, platform), ".claude")]) {
    if (dir === "") continue;
    let root: string;
    try {
      root = realpathSync(dir);
    } catch {
      continue;
    }
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

export type CrewGardenResult = CrewGardenHit | { refused: string } | undefined;

const usable = (r: CrewGardenResult): r is CrewGardenHit => r !== undefined && !("refused" in r);

/**
 * crew's garden, by crew's rules: a hit, `{ refused }` when crew would refuse discovery outright
 * (a symlinked manifest, an override that is not a plugin), or undefined when there is none.
 */
export function findGardenForCrew(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CrewGardenResult {
  const home = homeOf(env, platform);
  const override = env.WICKED_CREW_SKILLS_SOURCE;
  if (override) {
    // An explicit override is the only source crew reads (and crew does not judge its version floor).
    const version = manifestVersion(resolve(override));
    return typeof version === "string"
      ? { path: resolve(override), source: "WICKED_CREW_SKILLS_SOURCE", version }
      : { refused: `WICKED_CREW_SKILLS_SOURCE=${override} is not a wicked-garden plugin root (no usable .claude-plugin/plugin.json); crew reads only that, so fix or unset it` };
  }
  const linked = { refused: "a wicked-garden plugin manifest is a symlink, which crew refuses; reinstall wicked-garden" };
  const roots = crewClaudeConfigRoots(env, platform);
  for (const root of roots) {
    const hit = cacheHit(root, ["plugins", "cache", "wicked-garden", "wicked-garden"]);
    if (hit === LINK) return linked;
    if (hit) return { ...hit, source: "Claude Code plugin cache" };
  }
  for (const root of roots) {
    const dir = linkFreeBelow(root, ["plugins", "wicked-garden"]);
    const version = dir ? manifestVersion(dir) : undefined;
    if (version === LINK) return linked;
    if (dir && version !== undefined) return { path: dir, source: "Claude Code plugin copy", version };
  }
  // Tiers 4-5 exist from crew 0.18.0; an older crew stops at its Claude Code sources.
  if (!crewKnowsInstallerLocations(env, platform)) return undefined;

  const path = crewEnv(env, platform);
  const fromLauncher = launcherPackage("wicked-garden", "wicked-garden", path, platform);
  const launcherVersion = fromLauncher ? manifestVersion(fromLauncher) : undefined;
  if (launcherVersion === LINK) return linked;
  if (fromLauncher && launcherVersion !== undefined) return { path: fromLauncher, source: "npm package (wicked-garden on PATH)", version: launcherVersion };
  const crewPkg = launcherPackage("wicked-crew", "wicked-crew", path, platform);
  if (crewPkg) {
    const beside = join(dirname(crewPkg), "wicked-garden");
    const version = manifestVersion(beside);
    if (version === LINK) return linked;
    if (version !== undefined) return { path: beside, source: "npm package beside wicked-crew", version };
  }

  // Codex: below the canonical CODEX_HOME nothing is followed, and every marketplace is judged
  // before the pick (a linked manifest in any of them makes crew refuse).
  let codexRoot: string;
  try {
    codexRoot = realpathSync(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex"));
  } catch {
    return undefined;
  }
  const cacheDir = linkFreeBelow(codexRoot, ["plugins", "cache"]);
  if (!cacheDir) return undefined;
  let pick: CrewGardenHit | undefined;
  for (const marketplace of subdirs(cacheDir)) {
    if (isLink(marketplace)) continue;
    const hit = cacheHit(marketplace, ["wicked-garden"]);
    if (hit === LINK) return linked;
    if (hit && !pick) pick = { ...hit, source: "Codex plugin cache" };
  }
  return pick;
}

export { usable as isCrewGardenHit };

/** crew's garden floor when no crew is installed to read it from (REQUIRED_GARDEN_VERSION in crew 0.18.1). */
export const FALLBACK_GARDEN_FLOOR = "12.66.1";

const FLOOR_LITERAL = /REQUIRED_GARDEN_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/;

/**
 * The garden version the crew being installed demands: REQUIRED_GARDEN_VERSION, read as text from the
 * installed crew's dist/skills/plugin-source.js (never executed), else the pinned fallback.
 */
export function crewGardenFloor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { version: string; from: "crew" | "fallback" } {
  const pkg = launcherPackage("wicked-crew", "wicked-crew", crewEnv(env, platform), platform);
  if (pkg) {
    try {
      const m = FLOOR_LITERAL.exec(readFileSync(join(pkg, "dist", "skills", "plugin-source.js"), "utf8"));
      if (m?.[1]) return { version: m[1], from: "crew" };
    } catch {
      // unreadable: use the pinned floor
    }
  }
  return { version: FALLBACK_GARDEN_FLOOR, from: "fallback" };
}

/** What to do for a registered (not npm) garden below the floor; the registration itself is never touched. */
function pluginUpdateSteps(hit: CrewGardenHit, platform: NodeJS.Platform): string {
  const up = (n: number): string => {
    let d = hit.path;
    for (let i = 0; i < n; i += 1) d = dirname(d);
    return d;
  };
  if (hit.source === "Codex plugin cache") {
    const marketplace = basename(up(2));
    return `Codex: make the "${marketplace}" marketplace offer a newer wicked-garden (update its source), then run \`codex plugin add wicked-garden@${marketplace} --json\``;
  }
  const root = hit.source === "Claude Code plugin cache" ? up(5) : up(2);
  // renderClaudeCommand pins CLAUDE_CONFIG_DIR and quotes it for the platform's shell.
  const cmd = (args: string[]): string => renderClaudeCommand(root, args, platform);
  const update = cmd(["plugin", "update", "wicked-garden@wicked-garden"]);
  if (hit.source === "Claude Code plugin cache") {
    return `Claude Code: ${cmd(["plugin", "marketplace", "update", "wicked-garden"])}, then ${update} (add --scope project|local when it is registered there: a scopeless update covers the user scope only)`;
  }
  return `Claude Code: this is the older installer copy (${hit.path}); register wicked-garden again with ${cmd(["plugin", "install", "wicked-garden@wicked-garden"])}, or update an existing registration with ${update}`;
}

/** Run npm once with `args`, then look again: success needs a garden crew finds AND at or above `floor`. */
function npmInstallGarden(
  run: (cmd: string, args: string[]) => { status: number | null; error?: string },
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  floor: string,
  failure: string,
): { action: "installed" | "failed"; message: string } {
  const r = run("npm", args);
  const found = r.status === 0 ? findGardenForCrew(env, platform) : undefined;
  if (usable(found) && (found.source === "WICKED_CREW_SKILLS_SOURCE" || atLeast(found.version, floor))) {
    return { action: "installed", message: `the wicked-garden npm package was installed globally for crew (${found.version}, ${found.path})` };
  }
  const why = r.status !== 0 ? `npm ${r.error ?? `exited ${r.status ?? "?"}`}` : usable(found) ? `crew still finds ${found.version} at ${found.path}, below ${floor}` : "crew still finds no garden";
  return { action: "failed", message: `${failure} (${why})` };
}

/**
 * Garden delivered only as OpenCode / Pi / Antigravity skill copies (or a failed Claude Code
 * registration) is invisible to crew, which then refuses every job (first-run B3). When crew and
 * garden are both being installed and crew would find no garden, install the wicked-garden npm
 * package globally — crew finds it there on every platform (source 4).
 *
 * A garden crew does find is judged against the floor of the crew being installed whenever crew is
 * in the install set (#56): an older one makes `wicked-crew serve` refuse every launch with 422
 * garden_required. A stale npm package is upgraded once; a stale Claude Code / Codex registration is
 * left alone and the update steps are returned. An explicit WICKED_CREW_SKILLS_SOURCE is exempt
 * (crew does not judge it). Returns a line to print.
 */
export function ensureGardenForCrew(opts: {
  productIds: string[];
  dryRun: boolean;
  /** --source-root: garden must come from that checkout, never the published package. */
  sourceRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[]) => { status: number | null; error?: string };
}): { action: "not-needed" | "present" | "planned" | "installed" | "failed"; message: string } {
  if (!opts.productIds.includes("wicked-crew")) return { action: "not-needed", message: "" };
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? ((cmd: string, args: string[]) => {
    // npm is npm.cmd on Windows: a shell resolves it (fixed args, nothing user-supplied).
    const r = spawnSync(cmd, args, { env, stdio: "inherit", shell: platform === "win32" });
    return { status: r.status, error: r.error?.message };
  });
  const now = findGardenForCrew(env, platform);
  if (usable(now)) {
    if (now.source === "WICKED_CREW_SKILLS_SOURCE") return { action: "present", message: "" };
    const floor = crewGardenFloor(env, platform);
    if (atLeast(now.version, floor.version)) return { action: "present", message: "" };
    const stale = `wicked-garden ${now.version} (${now.source}, ${now.path}) is older than the ${floor.version} this wicked-crew requires, so crew would refuse every launch with garden_required`;
    if (!now.source.startsWith("npm package")) return { action: "failed", message: `${stale}. Left as is; update it: ${pluginUpdateSteps(now, platform)}` };
    const fix = "npm install -g wicked-garden@latest";
    if (opts.sourceRoot) return { action: "failed", message: `${stale}; with --source-root the published package is not installed in its place: update that checkout, or run \`${fix}\`` };
    if (opts.dryRun) return { action: "planned", message: `dry-run: ${stale}; would run \`${fix}\`` };
    return npmInstallGarden(run, ["install", "-g", "wicked-garden@latest"], env, platform, floor.version, `${stale}; run \`${fix}\` yourself`);
  }
  if (!opts.productIds.includes("wicked-garden")) return { action: "not-needed", message: "" };
  // Another copy cannot fix a refusal (a bad override, a linked manifest), and an older crew does
  // not look at npm packages: say what to do instead of installing something crew ignores.
  if (now && "refused" in now) return { action: "failed", message: `crew will not load wicked-garden here: ${now.refused}` };
  if (!crewKnowsInstallerLocations(env, platform)) return { action: "failed", message: `the wicked-crew on PATH is older than ${CREW_FINDS_INSTALLER_LOCATIONS} and finds wicked-garden only through Claude Code: npm i -g wicked-crew@latest, or install wicked-garden into Claude Code` };
  if (opts.sourceRoot) return { action: "failed", message: "crew finds no wicked-garden plugin, and with --source-root the published package is not installed in its place: register that checkout with Claude Code, or point WICKED_CREW_SKILLS_SOURCE at it" };
  if (opts.dryRun) return { action: "planned", message: "dry-run: after install, if crew finds no wicked-garden plugin (no Claude Code or Codex registration): npm install -g wicked-garden" };
  return npmInstallGarden(run, ["install", "-g", "wicked-garden"], env, platform, crewGardenFloor(env, platform).version, "crew finds no wicked-garden plugin, and `npm install -g wicked-garden` did not fix it; run it yourself");
}
