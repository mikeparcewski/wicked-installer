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
  /** Hook adapters the host's script installed for the product (marker `assets.hooks`). */
  hooks?: number;
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
  assets?: { skills?: unknown; hooks?: unknown };
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

function readJson(p: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const hasSkill = (dir: string, name: string): boolean => existsSync(join(dir, name, "SKILL.md"));

/** Skill dirs (holding a SKILL.md) under `dir` whose name starts with `prefix` — for markers that hold only a count. */
function prefixedSkills(dir: string, prefix: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  return entries.filter((n) => n.startsWith(prefix) && isDir(join(dir, n)) && hasSkill(dir, n)).length;
}

/**
 * Codex's own registration of the plugin: `codex plugin add` writes `[plugins."<id>"]` (with
 * `enabled = true`) into config.toml, and Codex loads only plugins configured there. Read, never
 * written. `registered: false` when the table is absent or config.toml cannot be read.
 */
function codexPluginConfig(home: string, pluginId: string): { registered: boolean; enabled?: boolean } {
  let raw: string;
  try {
    raw = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return { registered: false };
  }
  let inTable = false;
  let registered = false;
  let found: boolean | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      const key = header[1].replace(/\s+/g, "");
      inTable = key === `plugins."${pluginId}"` || key === `plugins.'${pluginId}'`;
      if (inTable) registered = true;
      continue;
    }
    if (!inTable) continue;
    const m = /^\s*enabled\s*=\s*(true|false)\s*(#.*)?$/.exec(line);
    if (m) found = m[1] === "true";
  }
  return { registered, enabled: found };
}

/** SKILL.md files under `dir`, recursively (links not followed) — how install-codex counts the plugin's skills. */
function countSkillFiles(dir: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (isDir(p)) n += countSkillFiles(p);
    else if (name === "SKILL.md") n += 1;
  }
  return n;
}

/** The plugin's cached payload holds a manifest at the recorded version and every skill the marker counted. */
function codexPayloadProblem(cache: string, version: string, recordedSkills: number): string | undefined {
  if (!isDir(cache)) return `its payload ${cache} is missing`;
  const manifest = [join(cache, ".codex-plugin", "plugin.json"), join(cache, ".claude-plugin", "plugin.json"), join(cache, "plugin.json")]
    .map(readJson)
    .find((m) => m !== undefined);
  if (!manifest) return `its payload ${cache} has no plugin manifest`;
  if (manifest.version !== version) return `its payload ${cache} is version ${String(manifest.version ?? "(none)")}, not ${version}`;
  const skills = countSkillFiles(join(cache, "skills"));
  if (skills === 0) return `its payload ${cache} holds no skills`;
  if (skills < recordedSkills) return `its payload ${cache} holds ${skills} of the ${recordedSkills} skills installed`;
  return undefined;
}

/** JSONC to JSON: drop line and block comments outside strings (the same rule install-opencode uses). */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] ?? "";
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next; i += 1; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      // A trailing comma (OpenCode's JSONC accepts it): drop it when only whitespace or comments
      // stand between it and the closing bracket.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (text[j] === "/" && text[j + 1] === "/") { while (j < text.length && text[j] !== "\n") j += 1; continue; }
        if (text[j] === "/" && text[j + 1] === "*") { const end = text.indexOf("*/", j + 2); j = end < 0 ? text.length : end + 2; continue; }
        break;
      }
      if (text[j] === "}" || text[j] === "]") continue;
    }
    if (ch === "/" && next === "/") { inLine = true; i += 1; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i += 1; continue; }
    out += ch;
  }
  return out;
}

/**
 * OpenCode loads copied skills only from a `skills.paths` entry in its config (install-opencode
 * registers it there). Parsed, not grepped: the path must be an entry of `skills.paths`.
 */
function opencodeSkillsPathProblem(home: string, skillsDir: string, userHome: string): string | undefined {
  const target = resolve(skillsDir);
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(stripJsonc(readFileSync(join(home, name), "utf8")));
    } catch {
      continue;
    }
    const paths = (cfg as { skills?: { paths?: unknown } } | null)?.skills?.paths;
    if (Array.isArray(paths) && paths.some((p) => typeof p === "string" && resolve(expand(p, userHome)) === target)) return undefined;
  }
  return `${skillsDir} is not registered in skills.paths of ${join(home, "opencode.jsonc")} (or opencode.json), so OpenCode does not load the copied skills`;
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
  const hooks = typeof entry.assets?.hooks === "number" ? entry.assets.hooks : 0;
  if (entry.success === false) {
    const why = typeof entry.lastFailure?.message === "string" ? `: ${entry.lastFailure.message}` : "";
    return { ...base, state: "broken", hooks, detail: `the last install recorded a failure${why}` };
  }
  if (entry.skipped === true) return { ...base, state: "not-installed", hooks, detail: "recorded as a manual step" };

  const skillsDir = spec.skillsDir(home);
  const names = Array.isArray(entry.skills) ? entry.skills.filter((n): n is string => typeof n === "string") : undefined;

  const plugin = entry.codexPlugin;
  let disabledNote = "";
  if (plugin && typeof plugin.marketplace === "string" && typeof plugin.version === "string" && typeof plugin.pluginId === "string") {
    const cfg = codexPluginConfig(home, plugin.pluginId);
    if (cfg.registered && cfg.enabled !== false) {
      const recordedSkills = typeof entry.assets?.skills === "number" ? entry.assets.skills : 0;
      const problem = codexPayloadProblem(join(home, "plugins", "cache", plugin.marketplace, plugin.pluginId.split("@")[0], plugin.version), plugin.version, recordedSkills);
      return problem
        ? { ...base, state: "broken", hooks, detail: `the marker records Codex plugin ${plugin.pluginId} ${plugin.version}, but ${problem}` }
        : { ...base, state: "installed", hooks, detail: `Codex plugin ${plugin.pluginId} ${plugin.version}` };
    }
    // Disabled, or no longer configured in config.toml: the loose skills the installer kept (if any) are what works.
    disabledNote = cfg.registered ? `Codex plugin ${plugin.pluginId} is disabled in Codex` : `Codex plugin ${plugin.pluginId} is not configured in ${join(home, "config.toml")}`;
    if (!names || names.length === 0) return { ...base, state: "not-installed", hooks, detail: disabledNote };
  }

  const prefix = disabledNote ? `${disabledNote}; ` : "";
  if (names && names.length > 0) {
    const missing = names.filter((n) => !hasSkill(skillsDir, n));
    if (missing.length > 0) {
      return { ...base, state: "broken", hooks, detail: `${prefix}${missing.length} of ${names.length} recorded skill dir(s) missing from ${skillsDir} (e.g. ${missing.slice(0, 3).join(", ")})` };
    }
  } else {
    // A marker from before names were recorded holds only a count: every copied dir is named
    // <productId>… (the scripts' naming rule), so all of them must still be there.
    const recorded = typeof entry.assets?.skills === "number" ? entry.assets.skills : 0;
    if (recorded === 0) return { ...base, state: "not-installed", hooks, detail: "the marker records no skills" };
    const found = prefixedSkills(skillsDir, productId);
    if (found < recorded) {
      return { ...base, state: "broken", hooks, detail: `the marker records ${recorded} skill(s), but ${found === 0 ? "none" : `only ${found}`} are in ${skillsDir}` };
    }
  }
  if (host === "opencode") {
    const problem = opencodeSkillsPathProblem(home, skillsDir, userHome);
    if (problem) return { ...base, state: "broken", hooks, detail: problem };
  }
  const count = names && names.length > 0 ? names.length : prefixedSkills(skillsDir, productId);
  return { ...base, state: "installed", hooks, detail: `${prefix}${count} skill dir(s) in ${skillsDir}` };
}
