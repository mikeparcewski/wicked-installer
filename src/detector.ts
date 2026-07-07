import { existsSync } from "node:fs";
import { join } from "node:path";
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
