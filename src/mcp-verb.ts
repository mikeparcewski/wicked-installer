// `wicked-installer mcp upsert|remove <key>` — the dispatcher half of the mcp verb (INTERFACE.md §12.5).
//
// Writes ONE ad-hoc MCP server into the operator's CLI MCP configurations, idempotently by key, and
// removes it again. index.ts stays a dispatcher and so does this file: every CLI's behaviour lives in
// its own script as a standalone verb mode (`node dist/install-<cli>.js mcp ...`, §2.1 ownership), and
// this module only parses, selects CLIs, runs each script and folds their envelopes into one.
//
// No --env, by design: an entry written by this verb carries no environment. The CLI host launches the
// server with the operator's shell environment, and the one secret a server needs is named by that
// server's own documentation — a secret VALUE is never written into a CLI config by this installer.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { detectCli, discoverCliScripts } from "./detector.js";

export const MCP_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const MCP_CLIS = ["claude", "codex", "opencode", "antigravity", "pi"] as const;
type McpCli = (typeof MCP_CLIS)[number];
export type McpResult = "written" | "converged" | "updated" | "removed" | "skipped" | "unsupported" | "manual" | "failed" | "planned";

export interface McpCliEntry {
  cli: string;
  result: McpResult;
  target: string;
  detail: string;
}

export interface McpEnvelope {
  verb: "upsert" | "remove";
  key: string;
  command: string | null;
  args: string[];
  dryRun: boolean;
  clis: McpCliEntry[];
}

/** Home flags each script accepts, by CLI (the first is the canonical spelling). */
const HOME_FLAGS: Record<McpCli, string[]> = {
  claude: ["--claude-home"],
  codex: ["--codex-home"],
  opencode: ["--opencode-home"],
  antigravity: ["--gemini-home", "--antigravity-home"],
  pi: ["--pi-home"],
};

interface McpVerbArgs {
  sub: "upsert" | "remove";
  key: string;
  command?: string;
  args: string[];
  clis: "all" | McpCli[];
  homes: Map<McpCli, string[]>;
  force: boolean;
  dryRun: boolean;
  json: boolean;
}

class UsageError extends Error {}

const expandHome = (value: string): string => value.replace(/^~(?=$|[/\\])/, () => homedir());

export function parseMcpVerbArgs(argv: string[]): McpVerbArgs {
  const [sub, key, ...rest] = argv;
  if (sub !== "upsert" && sub !== "remove") throw new UsageError(`mcp: expected 'upsert' or 'remove', got ${JSON.stringify(sub ?? "")}`);
  if (!key || !MCP_KEY_RE.test(key)) throw new UsageError(`mcp ${sub}: key ${JSON.stringify(key ?? "")} must match ^[a-z][a-z0-9-]{0,63}$`);
  const out: McpVerbArgs = { sub, key, args: [], clis: "all", homes: new Map(), force: false, dryRun: false, json: false };
  const homeFlagToCli = new Map<string, McpCli>();
  for (const cli of MCP_CLIS) for (const f of HOME_FLAGS[cli]) homeFlagToCli.set(f, cli);

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const homeCli = homeFlagToCli.get(name);
    if (name === "--command" || name === "--arg" || name === "--cli" || homeCli) {
      let value: string | undefined;
      if (arg !== name) value = arg.slice(name.length + 1);
      else if (i + 1 < rest.length) { i += 1; value = rest[i]; }
      if (value === undefined) throw new UsageError(`${name} requires a value`);
      if (name === "--command") out.command = value;
      else if (name === "--arg") out.args.push(value);
      else if (name === "--cli") {
        const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length === 1 && parts[0] === "all") out.clis = "all";
        else {
          const bad = parts.filter((p) => !(MCP_CLIS as readonly string[]).includes(p));
          if (parts.length === 0 || bad.length) throw new UsageError(`--cli: unknown CLI ${JSON.stringify(bad[0] ?? value)} (one of: all, ${MCP_CLIS.join(", ")})`);
          out.clis = [...new Set(parts as McpCli[])];
        }
      } else if (homeCli) {
        out.homes.set(homeCli, [...(out.homes.get(homeCli) ?? []), value]);
      }
    } else if (arg === "--force") out.force = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--env" || arg.startsWith("--env=")) throw new UsageError("--env is not supported: an entry written by this verb carries no environment (see --help)");
    else throw new UsageError(`unknown option: ${arg}`);
  }
  if (sub === "upsert") {
    if (!out.command) throw new UsageError("mcp upsert: --command <bin> is required");
    const cmd = expandHome(out.command);
    if (/[\u0000-\u001f\u007f-\u009f]/.test(cmd)) throw new UsageError("--command: contains control characters");
    if ((cmd.includes("/") || cmd.includes("\\")) && !isAbsolute(cmd)) {
      throw new UsageError(`--command: ${JSON.stringify(out.command)} must be a bare command name or an absolute path`);
    }
    out.command = cmd;
  }
  return out;
}

export function printMcpHelp(): void {
  console.log([
    "wicked-installer mcp — write one MCP server into your coding CLIs' MCP configs, idempotently by key",
    "",
    "Usage:",
    "  wicked-installer mcp upsert <key> --command <bin> [--arg <a>]... [--cli all|claude,codex,opencode,antigravity,pi]",
    "                                    [--force] [--dry-run] [--json] [--<cli>-home <dir>]...",
    "  wicked-installer mcp remove <key> [--cli ...] [--dry-run] [--json] [--<cli>-home <dir>]...",
    "",
    "  <key>       ^[a-z][a-z0-9-]{0,63}$ — the server name in every CLI",
    "  --command   a bare command name or an absolute path (leading ~ expanded)",
    "  --arg       one argument, passed through untouched (repeatable, in order)",
    "  --cli       default all = every CLI whose script is bundled and whose home or command is detected",
    "  --force     claude only: overwrite a same-name entry this installer did not write",
    "  --dry-run   print the envelope with result \"planned\"; write nothing",
    "  --json      one JSON envelope: {verb, key, command, args, dryRun, clis: [{cli, result, target, detail}]}",
    "  homes       --claude-home (repeatable), --codex-home, --opencode-home, --gemini-home, --pi-home",
    "",
    "Per CLI: claude writes mcpServers.<key> in .claude.json (backup, atomic write, recorded as mcp-server:<key>);",
    "codex and opencode use their own `mcp add`; opencode has no `mcp remove` (remove reports manual);",
    "pi and antigravity report unsupported (no stated MCP target, INTERFACE §8.3).",
    "",
    "No --env: an entry written here carries NO environment. The CLI launches the server with your shell",
    "environment; export the secret the server's documentation names there. No secret value is ever written.",
    "",
    "Exit: 0 when no CLI failed (skipped/unsupported/manual are not failures), 1 otherwise, 2 for bad arguments.",
  ].join("\n"));
}

/** The last complete JSON object on a script's stdout (§9.1 caution: parse from the tail). */
function tailJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  for (let i = text.lastIndexOf("{"); i >= 0; i = text.lastIndexOf("{", i - 1)) {
    if (i !== 0 && text[i - 1] !== "\n") continue;
    try {
      const v = JSON.parse(text.slice(i)) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* keep scanning back */
    }
    if (i === 0) break;
  }
  return undefined;
}

function runScript(cli: McpCli, scriptPath: string, a: McpVerbArgs): McpCliEntry[] {
  const argv = [scriptPath, "mcp", a.sub, a.key];
  if (a.command !== undefined) argv.push("--command", a.command);
  for (const v of a.args) argv.push("--arg", v);
  argv.push("--json");
  if (a.dryRun) argv.push("--dry-run");
  if (a.force) argv.push("--force");
  for (const home of a.homes.get(cli) ?? []) argv.push(HOME_FLAGS[cli][0], home);
  // Never rely on the shebang (Windows): always launch through node, no shell.
  const res = spawnSync(process.execPath, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const report = tailJson(res.stdout ?? "");
  const entries = Array.isArray(report?.clis) ? (report!.clis as McpCliEntry[]) : undefined;
  if (!entries || entries.length === 0) {
    const why = `${res.error?.message ?? ""}${res.stderr ?? ""}`.trim().slice(-400) || `exit ${res.status}`;
    return [{ cli, result: "failed", target: scriptPath, detail: `install-${cli}.js returned no mcp envelope: ${why}` }];
  }
  return entries;
}

function selectClis(a: McpVerbArgs, bundled: Map<string, string>): McpCli[] {
  if (a.clis !== "all") return a.clis;
  return MCP_CLIS.filter((cli) => bundled.has(cli) && (a.homes.has(cli) || detectCli(cli).detected));
}

const ICON: Record<McpResult, string> = {
  written: chalk.green("✓"), converged: chalk.green("✓"), updated: chalk.green("✓"), removed: chalk.green("✓"),
  planned: chalk.cyan("·"), skipped: chalk.yellow("~"), unsupported: chalk.yellow("~"), manual: chalk.yellow("~"),
  failed: chalk.red("✗"),
};

/** Run the verb; returns the process exit code. `scriptsDir` defaults to this file's dist/ dir. */
export async function runMcpVerb(argv: string[], scriptsDir = dirname(fileURLToPath(import.meta.url))): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printMcpHelp();
    return argv.length === 0 ? 2 : 0;
  }
  let a: McpVerbArgs;
  try {
    a = parseMcpVerbArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(chalk.red(`Error: ${err.message}`));
    return 2;
  }

  const bundled = new Map(discoverCliScripts(scriptsDir).map((s) => [s.cli, s.scriptPath]));
  const selected = selectClis(a, bundled);
  const clis: McpCliEntry[] = [];
  for (const cli of selected) {
    const script = bundled.get(cli);
    if (!script) {
      clis.push({ cli, result: "failed", target: "", detail: `no bundled install-${cli}.js in ${scriptsDir}` });
      continue;
    }
    clis.push(...runScript(cli, script, a));
  }

  const envelope: McpEnvelope = { verb: a.sub, key: a.key, command: a.command ?? null, args: a.args, dryRun: a.dryRun, clis };
  if (a.json) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    console.log(chalk.bold(`MCP server ${a.key} — ${a.sub}${a.dryRun ? " (dry run)" : ""}:`));
    if (clis.length === 0) console.log(chalk.dim("  no target CLI detected"));
    for (const e of clis) {
      console.log(`  ${ICON[e.result] ?? "?"} ${e.cli.padEnd(12)} ${e.result.padEnd(11)} ${chalk.dim(e.target)}`);
      if (e.detail) console.log(chalk.dim(`      ${e.detail}`));
    }
  }
  if (selected.length === 0) {
    console.error(chalk.red("mcp: no target CLI detected; pass --cli <list> (and a --<cli>-home if its home is not the default)"));
    return 1;
  }
  return clis.some((e) => e.result === "failed") ? 1 : 0;
}
