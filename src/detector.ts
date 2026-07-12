import { existsSync, readdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { DetectedCli } from "./types.js";

interface CliSpec {
  id: string;
  displayName: string;
  command?: string;
  homePath?: string;
  marker?: string;
}

const CLI_SPECS: CliSpec[] = [
  { id: "claude-code", displayName: "Claude Code",  command: "claude" },
  { id: "opencode",    displayName: "OpenCode",      command: "opencode" },
  { id: "codex",       displayName: "Codex",         command: "codex" },
  { id: "kiro",        displayName: "Kiro",          command: "kiro" },
  { id: "cursor",      displayName: "Cursor",        homePath: ".cursor", marker: "mcp.json" },
  { id: "copilot",     displayName: "GitHub Copilot",homePath: ".copilot", marker: "skills" },
  { id: "antigravity", displayName: "Antigravity",   homePath: ".gemini",  marker: "antigravity-cli" },
  { id: "pi",          displayName: "Pi",            homePath: ".pi",      marker: "agent" },
];

function commandVersion(cmd: string): string | undefined {
  try {
    return execSync(`${cmd} --version`, { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

function commandExists(cmd: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`where ${cmd}`, { timeout: 2000, stdio: "ignore" });
    } else {
      execSync(`command -v ${cmd}`, { timeout: 2000, stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

export function detectClis(): DetectedCli[] {
  const home = homedir();
  const found: DetectedCli[] = [];

  for (const spec of CLI_SPECS) {
    let detected = false;

    if (spec.command) {
      detected = commandExists(spec.command);
    } else if (spec.homePath) {
      const base = join(home, spec.homePath);
      detected = spec.marker
        ? existsSync(join(base, spec.marker))
        : existsSync(base);
    }

    if (detected) {
      const version = spec.command ? commandVersion(spec.command) : undefined;
      found.push({ id: spec.id, displayName: spec.displayName, version });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Central-picker CLI detection (INTERFACE.md §11.2 + §14)
//
// The registered CLIs ARE the install scripts: the picker offers exactly the
// slugs it finds by globbing dist/install-<cli>.js. For each slug we run the
// two-signal detection from §11.2 (binOnPath OR homeDetected) so detected CLIs
// can be pre-checked and absent ones still offered ("home will be created").
// ---------------------------------------------------------------------------

interface CliDetectSpec {
  cli: string;
  displayName: string;
  bins: string[];          // any resolvable on PATH ⇒ binOnPath
  homeEnv?: string;        // env var adding extra home roots (split on path.delimiter + ",")
  homeRoots: string[];     // roots relative to homedir()
  markers: string[];       // ANY-of identity markers inside a home root ([] ⇒ root existence alone)
}

const DETECT_SPECS: Record<string, CliDetectSpec> = {
  claude: {
    cli: "claude",
    displayName: "Claude Code",
    bins: ["claude"],
    homeEnv: "CLAUDE_CONFIG_DIR",
    // Only ~/.claude is a config root Claude Code actually reads (state lives in
    // ~/.claude.json alongside it); CLAUDE_CONFIG_DIR is the exclusive alternative and is
    // folded in via homeEnv. No alt-configs/.config probes — assets there would never load.
    homeRoots: [".claude"],
    markers: ["settings.json", "plugins", "projects"],
  },
  codex: {
    cli: "codex",
    displayName: "Codex",
    bins: ["codex"],
    homeEnv: "CODEX_HOME",
    homeRoots: [".codex"],
    markers: ["config.toml", "config.json", "auth.json", "plugins"],
  },
  // The Gemini family (Antigravity + Gemini CLI) shares one home, ~/.gemini,
  // owned by the single `antigravity` script (INTERFACE.md §2.1). There is NO
  // separate `gemini` slug: this spec's `bins` already include "gemini", so the
  // shared home is detected under this one entry. A separate `gemini` DETECT_SPEC
  // would resurrect the two-owners-one-home collision (finding, §11.2/§14).
  antigravity: {
    cli: "antigravity",
    displayName: "Antigravity",
    bins: ["gemini", "antigravity-cli"],
    homeEnv: "GEMINI_HOME",
    homeRoots: [".gemini"],
    markers: ["config.json", "auth", "settings.json"],
  },
  cursor: {
    cli: "cursor",
    displayName: "Cursor",
    bins: [],
    homeRoots: [".cursor"],
    markers: ["mcp.json", "User", "extensions", "settings.json"],
  },
  kiro: {
    cli: "kiro",
    displayName: "Kiro",
    bins: ["kiro"],
    homeRoots: [".kiro"],
    markers: ["config.json", "settings.json"],
  },
  opencode: {
    cli: "opencode",
    displayName: "OpenCode",
    bins: ["opencode"],
    homeRoots: [".config/opencode"],
    markers: ["opencode.json", "opencode.jsonc"],
  },
  pi: {
    cli: "pi",
    displayName: "Pi",
    bins: [],
    homeRoots: [".pi"],
    markers: ["agent"],
  },
};

function expandTilde(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, () => homedir());
}

function fallbackSpec(cli: string): CliDetectSpec {
  return {
    cli,
    displayName: cli.charAt(0).toUpperCase() + cli.slice(1),
    bins: [cli],
    homeRoots: [`.${cli}`],
    markers: [],
  };
}

function resolveHomeRoots(spec: CliDetectSpec): string[] {
  const roots = spec.homeRoots.map((r) => join(homedir(), r));
  const envVal = spec.homeEnv ? process.env[spec.homeEnv] : undefined;
  if (envVal) {
    // CLAUDE_CONFIG_DIR-style vars may list multiple paths (path.delimiter or ",").
    for (const raw of envVal.split(delimiter).flatMap((s) => s.split(","))) {
      const trimmed = raw.trim();
      if (trimmed) roots.push(expandTilde(trimmed));
    }
  }
  return roots;
}

function homeDetected(spec: CliDetectSpec): boolean {
  for (const root of resolveHomeRoots(spec)) {
    if (!existsSync(root)) continue;
    if (spec.markers.length === 0) return true; // bin-only CLI, or env-supplied root
    if (spec.markers.some((m) => existsSync(join(root, m)))) return true;
  }
  return false;
}

export interface CliPresence {
  cli: string;
  displayName: string;
  binOnPath: boolean;
  homeDetected: boolean;
  detected: boolean;
  version?: string;
}

/** Run the §11.2 two-signal detection for a single CLI slug. */
export function detectCli(cli: string): CliPresence {
  const spec = DETECT_SPECS[cli] ?? fallbackSpec(cli);
  let binOnPath = false;
  let version: string | undefined;
  for (const bin of spec.bins) {
    if (commandExists(bin)) {
      binOnPath = true;
      version = commandVersion(bin);
      break;
    }
  }
  const home = homeDetected(spec);
  return {
    cli: spec.cli,
    displayName: spec.displayName,
    binOnPath,
    homeDetected: home,
    detected: binOnPath || home,
    version,
  };
}

export interface CliScript {
  cli: string;
  scriptPath: string;
}

/**
 * Discover the per-CLI install scripts sitting next to dist/index.js.
 * Shipping dist/install-<cli>.js IS registering the CLI with the picker;
 * there is no separate adapter registry (INTERFACE.md §14, "Offer rule").
 */
export function discoverCliScripts(dir: string): CliScript[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const scripts: CliScript[] = [];
  for (const name of entries) {
    const match = /^install-([a-z0-9][a-z0-9-]*)\.js$/i.exec(name);
    if (match) scripts.push({ cli: match[1].toLowerCase(), scriptPath: join(dir, name) });
  }
  scripts.sort((a, b) => a.cli.localeCompare(b.cli));
  return scripts;
}

export function isProductInstalled(productId: string): boolean {
  switch (productId) {
    case "wicked-testing": {
      // Checks for a Claude Code install by looking for the skills dir
      const home = homedir();
      return existsSync(join(home, ".claude", "skills", "wicked-testing-acceptance-testing")) ||
             existsSync(join(home, ".claude", "skills", "wicked-testing:acceptance-testing"));
    }
    case "wicked-bus": {
      try {
        execSync("npx wicked-bus --version", { timeout: 3000, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
    case "wicked-brain": {
      const home = homedir();
      return existsSync(join(home, ".wicked-brain"));
    }
    case "wicked-garden": {
      const home = homedir();
      return existsSync(join(home, ".claude", "plugins", "wicked-garden", ".claude-plugin", "plugin.json"));
    }
    default:
      return false;
  }
}
