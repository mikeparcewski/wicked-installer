import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCliScripts } from "./detector.js";
import { loadRegistry } from "./registry.js";
import { claudePluginSpec, resolveClaudeConfigDirs, unregisterClaudePlugin } from "./claude-plugin.js";

const CLIS = ["claude", "codex", "opencode", "antigravity", "pi"] as const;
type Cli = (typeof CLIS)[number];
const HOME_FLAGS: Record<Cli, string> = { claude: "--claude-home", codex: "--codex-home", opencode: "--opencode-home", antigravity: "--gemini-home", pi: "--pi-home" };
interface Report {
  productId: string;
  success: boolean;
  skipped: boolean;
  message: string;
  removed?: string[];
  notes?: string[];
}
interface Host {
  cli: Cli;
  success: boolean;
  message: string;
  reports: Report[];
}
interface Args {
  ids: string[];
  all: boolean;
  clis: Cli[];
  homes: Map<Cli, string[]>;
  dryRun: boolean;
  json: boolean;
}

function printHelp(): void {
  console.log([
    "Usage: wicked-installer uninstall <ids...> | --all [--cli <list>] [--dry-run] [--json] [--<cli>-home <dir>]...",
    "",
    `  --cli   all (default), or a comma-separated list: ${CLIS.join(", ")}`,
    "  homes   --claude-home (repeatable), --codex-home, --opencode-home, --gemini-home, --pi-home",
    "  Removes recorded host integrations; shared binaries and the Claude marketplace stay in place.",
  ].join("\n"));
}

function parseArgs(argv: string[]): Args {
  const a: Args = { ids: [], all: false, clis: [...CLIS], homes: new Map(), dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag] = arg.split("=");
    const cli = CLIS.find((c) => HOME_FLAGS[c] === flag || (c === "antigravity" && flag === "--antigravity-home"));
    if (flag === "--cli" || cli) {
      const value = arg.includes("=") ? arg.slice(flag.length + 1) : argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (cli) a.homes.set(cli, [...(a.homes.get(cli) ?? []), value]);
      else {
        const names = value.split(",").map((n) => n.trim()).filter(Boolean);
        if (names.length === 1 && names[0] === "all") a.clis = [...CLIS];
        else {
          if (!names.length || names.some((n) => !(CLIS as readonly string[]).includes(n))) throw new Error(`unknown CLI: ${value}`);
          a.clis = [...new Set(names as Cli[])];
        }
      }
    } else if (arg === "--all") a.all = true;
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--json") a.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else a.ids.push(arg);
  }
  if (!a.all && !a.ids.length) throw new Error("uninstall requires <ids...> or --all");
  const products = loadRegistry().products;
  const unknown = a.ids.filter((id) => !products.some((p) => p.id === id) && !/^mcp-server:[a-z][a-z0-9-]{0,63}$/.test(id));
  if (unknown.length) throw new Error(`unknown product: ${unknown.join(", ")}`);
  return a;
}

function tailJson(stdout: string): { reports?: Report[] } | undefined {
  const text = stdout.trim();
  for (let i = text.lastIndexOf("{"); i >= 0; i = text.lastIndexOf("{", i - 1)) {
    if (i !== 0 && text[i - 1] !== "\n") continue;
    try { return JSON.parse(text.slice(i)) as { reports?: Report[] }; } catch { /* keep scanning */ }
  }
  return undefined;
}

export async function runUninstallVerb(argv: string[], scriptsDir = dirname(fileURLToPath(import.meta.url))): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { printHelp(); return 0; }
  let a: Args;
  try { a = parseArgs(argv); }
  catch (err) { console.error(err instanceof Error ? err.message : String(err)); printHelp(); return 1; }
  const scripts = new Map(discoverCliScripts(scriptsDir).map((s) => [s.cli, s.scriptPath]));
  const plugins = loadRegistry().products.filter((p) => p.type === "claude-plugin" && (a.all || a.ids.includes(p.id)));
  const hosts: Host[] = [];
  for (const cli of a.clis) {
    const host: Host = { cli, success: true, message: `not installed on ${cli}`, reports: [] };
    hosts.push(host);
    const script = scripts.get(cli);
    if (!script) { host.success = false; host.message = `no bundled install-${cli}.js`; continue; }
    const ids = cli === "claude" ? a.ids.filter((id) => !plugins.some((p) => p.id === id)) : a.ids;
    if (a.all || ids.length) {
      const args = [script, "uninstall", ...(a.all ? ["--all"] : ids), "--json"];
      if (a.dryRun) args.push("--dry-run");
      for (const home of a.homes.get(cli) ?? []) args.push(HOME_FLAGS[cli], home);
      const result = spawnSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const reports = tailJson(result.stdout ?? "")?.reports;
      if (Array.isArray(reports)) host.reports.push(...reports);
      if (result.status !== 0 && result.status !== 2) {
        host.success = false;
        host.message = `${result.error?.message ?? result.stderr?.trim() ?? ""}` || `install-${cli}.js exited ${result.status}`;
      } else if (!reports && result.status !== 2) {
        host.success = false;
        host.message = `install-${cli}.js returned no uninstall envelope`;
      }
    }
    if (cli === "claude" && plugins.length) {
      try {
        const configDirs = resolveClaudeConfigDirs({ homeFlags: a.homes.get("claude") });
        for (const product of plugins) host.reports.push(...unregisterClaudePlugin(claudePluginSpec(product), { configDirs, dryRun: a.dryRun }));
      } catch (err) { host.success = false; host.message = err instanceof Error ? err.message : String(err); }
    }
    if (host.reports.some((r) => !r.success)) host.success = false;
    if (host.success && host.reports.length) host.message = host.reports.map((r) => r.message).join("; ");
    else if (!host.success && host.reports.some((r) => !r.success)) host.message = host.reports.filter((r) => !r.success).map((r) => r.message).join("; ");
  }
  if (a.json) console.log(JSON.stringify({ verb: "uninstall", dryRun: a.dryRun, hosts }, null, 2));
  else for (const host of hosts) {
    const showHostMessage = !host.reports.length || (!host.success && host.reports.every((r) => r.success));
    console.log(`${host.cli}:${showHostMessage ? ` ${host.message}` : ""}`);
    for (const report of host.reports) {
      const status = !report.success ? "failed" : report.skipped ? "skipped" : "ok";
      console.log(`  [${status}] ${report.message}`);
      console.log(`    removed ${report.removed?.length ?? 0} path(s)`);
      for (const note of report.notes ?? []) console.log(`    ${note}`);
    }
  }
  return hosts.some((h) => !h.success) ? 1 : 0;
}
