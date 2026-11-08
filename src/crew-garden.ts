/**
 * Can wicked-crew SEE a wicked-garden here? (first-run B3/C5.)
 *
 * The installer can deliver garden to Codex, OpenCode or the npm prefix while Claude Code's
 * registration fails or is not selected. Crew's daemon then found no garden and refused every
 * launch, yet the readiness check said "ready wicked-crew". This mirrors crew's own garden
 * resolution order (wicked-crew `serve`, first hit wins), so readiness answers the question crew
 * will ask at boot instead of "is some copy of garden somewhere":
 *   1. WICKED_CREW_SKILLS_SOURCE
 *   2. Claude Code's marketplace cache <CLAUDE_CONFIG_DIR|~/.claude>/plugins/cache/wicked-garden/wicked-garden/<version>
 *   3. the older installer copy <config dir>/plugins/wicked-garden (and ~/.claude/plugins/wicked-garden)
 *   4. the npm package: the realpath of the `wicked-garden` launcher on PATH, else the
 *      wicked-garden package beside wicked-crew's own global install
 *   5. Codex's plugin cache <CODEX_HOME|~/.codex>/plugins/cache/<marketplace>/wicked-garden/<version>
 * A candidate counts only when it holds `.claude-plugin/plugin.json` (crew's plugin-root test).
 * OpenCode / Pi / Antigravity skill copies are not a source for crew: they carry skills only.
 * Crew also compares the version with its floor; that floor lives in crew, so it is not checked here.
 * Filesystem probes only — nothing is spawned.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { probeOnPath } from "./claude-plugin.js";

export interface CrewGardenHit {
  path: string;
  /** Which of crew's sources matched, in words. */
  source: string;
}

function isPluginRoot(dir: string): boolean {
  try {
    return statSync(join(dir, ".claude-plugin", "plugin.json")).isFile();
  } catch {
    return false;
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

function expand(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : p;
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

export function findGardenForCrew(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CrewGardenHit | undefined {
  const home = (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
  const override = env.WICKED_CREW_SKILLS_SOURCE?.trim();
  if (override) {
    const dir = resolve(expand(override, home));
    // An explicit override is the only source crew reads: say so either way.
    return isPluginRoot(dir) ? { path: dir, source: "WICKED_CREW_SKILLS_SOURCE" } : undefined;
  }
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(expand(env.CLAUDE_CONFIG_DIR.trim(), home)) : join(home, ".claude");
  const defaultClaude = join(home, ".claude");

  const cache = subdirs(join(configDir, "plugins", "cache", "wicked-garden", "wicked-garden")).find(isPluginRoot);
  if (cache) return { path: cache, source: "Claude Code plugin cache" };

  for (const dir of [join(configDir, "plugins", "wicked-garden"), join(defaultClaude, "plugins", "wicked-garden")]) {
    if (isPluginRoot(dir)) return { path: dir, source: "Claude Code plugin copy" };
  }

  const fromLauncher = launcherPackage("wicked-garden", "wicked-garden", env, platform);
  if (fromLauncher && isPluginRoot(fromLauncher)) return { path: fromLauncher, source: "npm package (wicked-garden on PATH)" };
  const crewPkg = launcherPackage("wicked-crew", "wicked-crew", env, platform);
  if (crewPkg) {
    const beside = join(dirname(crewPkg), "wicked-garden");
    if (isPluginRoot(beside)) return { path: beside, source: "npm package beside wicked-crew" };
  }

  const codexHome = env.CODEX_HOME?.trim() ? resolve(expand(env.CODEX_HOME.trim(), home)) : join(home, ".codex");
  for (const marketplace of subdirs(join(codexHome, "plugins", "cache"))) {
    const hit = subdirs(join(marketplace, "wicked-garden")).find(isPluginRoot);
    if (hit) return { path: hit, source: "Codex plugin cache" };
  }
  return undefined;
}
