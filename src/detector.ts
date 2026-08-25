import { existsSync, readdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { DetectedCli, Product } from "./types.js";
import { loadRegistry } from "./registry.js";

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

/**
 * Is this product installed on this machine?
 *
 * The shape here used to be a switch over four product ids with `default: return false`, which
 * meant every product NOT in the switch reported "not installed" no matter what was on disk. On a
 * machine running `wicked-crew serve` this printed "not installed  wicked-crew" — the status command
 * contradicting a daemon that was serving requests at that moment. wicked-estate, wicked-interactive
 * and wicked-studio were wrong the same way. A status surface that answers `false` for anything it
 * has not been taught about is worse than one that says "unknown": it reads as a checked negative.
 *
 * So the DEFAULT is now derived from what the registry already says about how a product installs,
 * and the switch holds only the genuine special cases:
 *
 *  - `npm-global` / `npm-run` with a package ⇒ is its binary on PATH. That is the same question the
 *    user is really asking ("can I run this?"), and it is agnostic about WHERE it came from —
 *    homebrew's prefix, an npm global prefix, `~/.local/bin`, a version manager's shim. The old
 *    hand-rolled checks were all location-specific and this machine has products in three different
 *    prefixes;
 *  - `cargo` ⇒ the crate's binary, likewise on PATH (`~/.cargo/bin`, or `~/.local/bin`);
 *  - `manual` ⇒ not independently installable, so it is installed exactly when its requirements are
 *    (wicked-studio ships INSIDE wicked-crew). The caller renders these as "manual" anyway.
 *
 * Special cases that survive, and why each one is not just a PATH probe:
 *
 *  - **wicked-testing** is retired and was never a binary — it installed SKILLS into `~/.claude`, so
 *    the skills dir is the only evidence it was ever here.
 *  - **wicked-garden** is a Claude Code PLUGIN, not a CLI: its evidence is the installed plugin
 *    manifest, and `wicked-garden` on PATH would prove nothing about the plugin being wired in.
 *  - **wicked-brain** is retired, and `~/.wicked-brain` is a FROZEN ARCHIVE that must never be
 *    deleted. Reporting "installed" because the archive exists tells an operator to uninstall
 *    something that is not installed — and the safe answer to "is this retired thing present" is
 *    about the PACKAGE, not its leftover data. The archive is deliberately not consulted.
 */
export function isProductInstalled(productId: string, seen: ReadonlySet<string> = new Set()): boolean {
  // The `manual` arm recurses through `requires`, and requires comes from registry.json — data
  // that ships in the package and can be hand-edited or corrupted, exactly like the binary names
  // guarded above. A self-reference (`requires: ["itself"]`) or a cycle (A→B→A) would recurse
  // until the stack blew, turning a corrupt data file into a crash of the status command rather
  // than a wrong answer. A product already on the current chain is treated as NOT satisfied:
  // nothing in a dependency cycle can be shown installed on the strength of the cycle itself.
  if (seen.has(productId)) return false;
  const chain = new Set(seen).add(productId);
  const home = homedir();
  switch (productId) {
    case "wicked-testing":
      // Retired, and never a binary: it installed skills into Claude Code's skills dir.
      return existsSync(join(home, ".claude", "skills", "wicked-testing-acceptance-testing")) ||
             existsSync(join(home, ".claude", "skills", "wicked-testing:acceptance-testing"));
    case "wicked-garden":
      // A plugin, not a CLI — the manifest is the evidence.
      return existsSync(join(home, ".claude", "plugins", "wicked-garden", ".claude-plugin", "plugin.json"));
    case "wicked-brain":
      // Retired. `~/.wicked-brain` is a frozen archive, NOT an install — see the header.
      return commandExists("wicked-brain");
    default:
      return installedPerRegistry(productId, chain);
  }
}

/**
 * A shell-safe executable name.
 *
 * `commandExists` interpolates into `execSync`, and these names come from registry.json rather
 * than from source — a file that ships in the package and could be corrupted, hand-edited, or
 * replaced. An entry like `x; rm -rf ~` would otherwise reach a shell. Nothing legitimate needs
 * more than this alphabet, so anything outside it is rejected rather than escaped: a name we would
 * have to quote to make safe is a name we should not be probing.
 *
 * It also removes a quieter failure — a package name carrying a space or a `$` would make
 * `command -v` answer about something other than the thing asked about, and report it as fact.
 */
const SAFE_BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function commandExistsSafe(name: string): boolean {
  return SAFE_BINARY.test(name) && commandExists(name);
}

/** Detection derived from the product's own `install` spec, so a new product needs no new branch. */
function installedPerRegistry(productId: string, seen: ReadonlySet<string>): boolean {
  const product: Product | undefined = loadRegistry().products.find((p) => p.id === productId);
  if (product === undefined) return false;
  const install = product.install;
  switch (install.type) {
    case "npm-global":
    case "npm-run":
      // The binary is conventionally the package name for every wicked-* product.
      return typeof install.package === "string" && commandExistsSafe(install.package);
    case "cargo": {
      // The crate may publish a differently-named binary (wicked-estate-mcp ⇒ wicked-estate).
      const crate = install.crate ?? install.package;
      if (typeof crate !== "string") return false;
      return commandExistsSafe(crate) || commandExistsSafe(crate.replace(/-mcp$/, ""));
    }
    case "manual": {
      // Ships inside something else; installed exactly when that thing is.
      //
      // `requires` is validated, not assumed. This whole function exists to tolerate a corrupted
      // registry.json — it guards binary names against shell metacharacters and `requires` against
      // cycles — so reaching `.every` on a value that turned out to be a string or an object would
      // throw and crash `status` for exactly the input the rest of the code is careful about.
      // Bad data yields a safe `false`; it never yields an exception.
      const requires = product.requires;
      if (!Array.isArray(requires) || requires.length === 0) return false;
      return requires.every((r) => typeof r === "string" && isProductInstalled(r, seen));
    }
    default:
      return false;
  }
}
