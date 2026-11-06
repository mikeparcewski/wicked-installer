/**
 * host-status.ts — is a product installed on each NON-Claude host, read from disk only.
 *
 * `status` used to answer "is wicked-garden installed?" with the Claude Code plugin registration
 * alone, so a Codex, OpenCode or Pi home the installer had just written to read "not installed"
 * and exited 1. Each install-<cli>.js records what it delivered in its marker
 * (`<home>/wicked-installer/<cli>-install.json`, INTERFACE.md §10); this module reads that record
 * and checks the on-disk evidence it names:
 *
 *  - Codex plugin: the marker's `codexPlugin` record plus Codex's own cached copy
 *    `<codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/`;
 *  - copied skills (Codex loose copy, OpenCode, Pi, Antigravity): the skill directories in the
 *    host's skills dir (the names the marker lists, else the `<productId>…` dirs).
 *
 * A marker entry whose evidence is gone is `broken`, never `installed`. Nothing is spawned and
 * nothing is written. The home resolution mirrors each script's own defaults and env vars.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type HostInstallState = "installed" | "not-installed" | "broken" | "unreadable";

export interface HostProductStatus {
  host: string;
  displayName: string;
  home: string;
  marker: string;
  state: HostInstallState;
  detail: string;
}

interface HostSpec {
  displayName: string;
  home: (env: NodeJS.ProcessEnv, home: string) => string;
  skillsDir: (home: string) => string;
}

function expand(value: string, home: string): string {
  return value.replace(/^~(?=$|[/\\])/, () => home);
}

/** The four v1 hosts; Claude Code is reported by the plugin-registration section. */
export const NON_CLAUDE_HOSTS: Record<string, HostSpec> = {
  codex: {
    displayName: "Codex",
    home: (env, home) => resolve(env.CODEX_HOME ? expand(env.CODEX_HOME, home) : join(home, ".codex")),
    skillsDir: (h) => join(h, "skills"),
  },
  opencode: {
    displayName: "OpenCode",
    home: (env, home) => resolve(env.OPENCODE_CONFIG ? expand(env.OPENCODE_CONFIG, home) : join(home, ".config", "opencode")),
    skillsDir: (h) => join(h, "skills"),
  },
  pi: {
    displayName: "Pi",
    home: (env, home) => resolve(env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent")),
    skillsDir: (h) => join(h, "skills"),
  },
  antigravity: {
    displayName: "Antigravity",
    home: (env, home) => resolve(env.GEMINI_HOME ? expand(env.GEMINI_HOME, home) : join(home, ".gemini")),
    skillsDir: (h) => join(h, "config", "skills"),
  },
};

interface MarkerEntry {
  id?: unknown;
  success?: unknown;
  skipped?: unknown;
  assets?: { skills?: unknown };
  skills?: unknown;
  codexPlugin?: { pluginId?: unknown; marketplace?: unknown; version?: unknown; enabled?: unknown };
  lastFailure?: { message?: unknown };
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Skill dirs (holding a SKILL.md) under `dir` named in `names`, or starting with `prefix`. */
function presentSkills(dir: string, names: string[] | undefined, prefix: string): number {
  if (names) return names.filter((n) => existsSync(join(dir, n, "SKILL.md"))).length;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  return entries.filter((n) => n.startsWith(prefix) && isDir(join(dir, n)) && existsSync(join(dir, n, "SKILL.md"))).length;
}

export function hostProductStatus(
  productId: string,
  host: string,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): HostProductStatus | undefined {
  const spec = NON_CLAUDE_HOSTS[host];
  if (!spec) return undefined;
  const env = opts.env ?? process.env;
  const userHome = opts.home ?? homedir();
  const home = spec.home(env, userHome);
  const marker = join(home, "wicked-installer", `${host}-install.json`);
  const base = { host, displayName: spec.displayName, home, marker };

  if (!existsSync(marker)) return { ...base, state: "not-installed", detail: "no install marker" };
  let entries: MarkerEntry[];
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { products?: unknown };
    entries = Array.isArray(parsed?.products) ? (parsed.products as MarkerEntry[]) : [];
  } catch (err) {
    return { ...base, state: "unreadable", detail: `install marker unreadable (${err instanceof Error ? err.message : String(err)})` };
  }
  const entry = entries.find((e) => e && typeof e === "object" && e.id === productId);
  if (!entry) return { ...base, state: "not-installed", detail: "not in the install marker" };
  if (entry.success === false) {
    const why = typeof entry.lastFailure?.message === "string" ? `: ${entry.lastFailure.message}` : "";
    return { ...base, state: "broken", detail: `the last install recorded a failure${why}` };
  }
  if (entry.skipped === true) return { ...base, state: "not-installed", detail: "recorded as a manual step" };

  const plugin = entry.codexPlugin;
  if (plugin && typeof plugin.marketplace === "string" && typeof plugin.version === "string" && typeof plugin.pluginId === "string") {
    const name = plugin.pluginId.split("@")[0];
    const cache = join(home, "plugins", "cache", plugin.marketplace, name, plugin.version);
    if (plugin.enabled === false) return { ...base, state: "not-installed", detail: `Codex plugin ${plugin.pluginId} ${plugin.version} is installed but disabled in Codex` };
    return isDir(cache)
      ? { ...base, state: "installed", detail: `Codex plugin ${plugin.pluginId} ${plugin.version}` }
      : { ...base, state: "broken", detail: `the marker records Codex plugin ${plugin.pluginId} ${plugin.version}, but its payload ${cache} is missing` };
  }

  const skillsDir = spec.skillsDir(home);
  const names = Array.isArray(entry.skills) ? entry.skills.filter((n): n is string => typeof n === "string") : undefined;
  const recorded = names ? names.length : typeof entry.assets?.skills === "number" ? entry.assets.skills : 0;
  const found = presentSkills(skillsDir, names, productId);
  if (found > 0) return { ...base, state: "installed", detail: `${found} skill dir(s) in ${skillsDir}` };
  if (recorded > 0) return { ...base, state: "broken", detail: `the marker records ${recorded} skill(s), but none are in ${skillsDir}` };
  return { ...base, state: "not-installed", detail: "the marker records no skills" };
}
