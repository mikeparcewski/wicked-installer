#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import boxen from "boxen";
import { detectClis, discoverCliScripts, detectCli } from "./detector.js";
import { installProduct } from "./installer.js";
import { promptSelectionMode, promptBundle, promptCustom, promptConfirm, promptClis } from "./ui.js";
import type { CliOption, UserSelection } from "./ui.js";
import { listProducts, getProduct } from "./registry.js";
import type { InstallResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };

interface DispatchFlags {
  dryRun: boolean;
  force: boolean;
}

// ---------------------------------------------------------------------------
// Report parsing (INTERFACE.md §9). Each per-CLI script prints exactly one
// pretty-printed JSON report to stdout with --json, but on a real install the
// acquisition child processes' stdout can precede it, so we parse the LAST
// balanced JSON object (the report is always the trailing object).
// ---------------------------------------------------------------------------

interface ScriptReportEntry {
  productId: string;
  displayName?: string;
  success: boolean;
  skipped: boolean;
  message?: string;
}

interface ScriptReport {
  reports?: ScriptReportEntry[];
  [key: string]: unknown; // <cli>Home + v1.1 additive keys
}

/**
 * From `start` (which must point at "{"), return the index just past the
 * matching "}", or -1 if the object never closes. String- and escape-aware so
 * braces inside string values are ignored.
 */
function matchBalancedObject(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Extract the last parseable top-level JSON object from possibly-noisy stdout.
 * On a real install the acquisition child processes interleave output before the
 * report, so we walk every "{", greedily match a balanced object, and keep the
 * last one that parses. Robust to arbitrary (even unbalanced) leading noise.
 */
export function parseTailJson(raw: string): ScriptReport | undefined {
  let last: ScriptReport | undefined;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "{") {
      i += 1;
      continue;
    }
    const end = matchBalancedObject(raw, i);
    if (end === -1) {
      i += 1; // this "{" never closes (stray noise) — skip it and retry
      continue;
    }
    try {
      const parsed = JSON.parse(raw.slice(i, end)) as unknown;
      if (parsed && typeof parsed === "object") last = parsed as ScriptReport;
    } catch {
      /* not valid JSON from here; fall through */
    }
    i = end; // consume the matched object whether or not it parsed
  }
  return last;
}

function homeFromReport(report: ScriptReport | undefined): string | undefined {
  if (!report) return undefined;
  for (const key of Object.keys(report)) {
    if (/Home$/.test(key) && typeof report[key] === "string") return report[key] as string;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dispatch (INTERFACE.md §14)
// ---------------------------------------------------------------------------

interface CliRunResult {
  cli: string;
  displayName: string;
  status: number | null;
  present: boolean;     // false only when the script exits 2 ("CLI not present")
  parsed: boolean;
  home?: string;
  entries: ScriptReportEntry[];
  rawTail: string;
}

function runCliScript(
  cli: CliOption,
  productIds: string[],
  flags: DispatchFlags,
  skipBinaries: boolean,
): CliRunResult {
  const args = [cli.scriptPath, ...productIds, "--json"];
  if (skipBinaries) args.push("--skip-binaries");
  if (flags.dryRun) args.push("--dry-run");
  if (flags.force) args.push("--force");

  // Never rely on the script's shebang (Windows): always launch via node.
  const res = spawnSync(process.execPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  const stdout = res.stdout ?? "";
  const status = res.status;
  const present = status !== 2; // §3.3: exit 2 means the CLI isn't present
  const report = parseTailJson(stdout);
  const parsed = report !== undefined;

  return {
    cli: cli.cli,
    displayName: cli.displayName,
    status,
    present,
    parsed,
    home: homeFromReport(report),
    entries: Array.isArray(report?.reports) ? (report!.reports as ScriptReportEntry[]) : [],
    rawTail: stdout.slice(-600).trim(),
  };
}

export async function dispatchToClis(
  clis: CliOption[],
  productIds: string[],
  flags: DispatchFlags,
): Promise<number> {
  const results: CliRunResult[] = [];

  clis.forEach((cli, index) => {
    // Binaries are machine-scoped: acquire once (first script), skip thereafter.
    const skipBinaries = index > 0;
    const suffix = skipBinaries ? chalk.dim(" (binaries already acquired)") : "";
    console.log(`\n${chalk.cyan("→")} Installing into ${chalk.bold(cli.displayName)}${suffix}${flags.dryRun ? chalk.dim(" [dry-run]") : ""}...`);
    results.push(runCliScript(cli, productIds, flags, skipBinaries));
  });

  const hadFailure = renderSummary(results, productIds);

  if (hadFailure) {
    console.log(chalk.red("\nOne or more installations failed. See the summary above."));
    return 1;
  }
  console.log(chalk.green(`\nDone! ${flags.dryRun ? "(dry-run — nothing was written)" : "Start your coding agent to activate the installed tools."}`));
  return 0;
}

interface Cell {
  plain: string;
  colored: string;
}

function cell(plain: string, color: (s: string) => string): Cell {
  return { plain, colored: color(plain) };
}

function statusCell(result: CliRunResult, productId: string): Cell {
  if (!result.present) return cell("n/a", chalk.dim);
  if (!result.parsed) return cell("error", chalk.red);
  const entry = result.entries.find((e) => e.productId === productId);
  if (!entry) return cell("-", chalk.dim);
  if (!entry.success) return cell("failed", chalk.red);
  if (entry.skipped) return cell("manual", chalk.yellow);
  return cell("ok", chalk.green);
}

/** Render the product × CLI grid. Returns true when any run failed. */
export function renderSummary(results: CliRunResult[], productIds: string[]): boolean {
  const displayNameFor = (id: string): string => {
    for (const r of results) {
      const e = r.entries.find((x) => x.productId === id);
      if (e?.displayName) return e.displayName;
    }
    return getProduct(id)?.displayName ?? id;
  };

  const header: Cell[] = [cell("Product", chalk.bold), ...results.map((r) => cell(r.displayName, chalk.bold))];
  const rows: Cell[][] = [header];

  for (const id of productIds) {
    const row: Cell[] = [cell(displayNameFor(id), (s) => s)];
    for (const r of results) row.push(statusCell(r, id));
    rows.push(row);
  }

  const colCount = header.length;
  const widths: number[] = [];
  for (let c = 0; c < colCount; c += 1) {
    widths[c] = Math.max(...rows.map((row) => row[c].plain.length));
  }

  console.log(chalk.bold("\nSummary:"));
  for (const row of rows) {
    const line = row
      .map((c, i) => c.colored + " ".repeat(widths[i] - c.plain.length))
      .join("   ");
    console.log(`  ${line}`);
  }

  // Per-CLI homes + failure diagnostics.
  const notes: string[] = [];
  for (const r of results) {
    if (!r.present) {
      notes.push(`${chalk.dim(r.displayName + ":")} not present (skipped)`);
    } else if (r.status !== 0 && !r.parsed) {
      notes.push(`${chalk.red(r.displayName + ":")} produced no parseable report (exit ${r.status ?? "?"})` + (r.rawTail ? `\n${chalk.dim("    " + r.rawTail.replace(/\n/g, "\n    "))}` : ""));
    } else if (!r.parsed) {
      notes.push(`${chalk.red(r.displayName + ":")} could not parse report output` + (r.rawTail ? `\n${chalk.dim("    " + r.rawTail.replace(/\n/g, "\n    "))}` : ""));
    } else if (r.home) {
      notes.push(`${chalk.dim(r.displayName + " home:")} ${r.home}`);
    }
  }
  if (notes.length > 0) {
    console.log();
    for (const n of notes) console.log(`  ${n}`);
  }

  return results.some((r) => {
    if (!r.present) return false;      // exit 2 → CLI not present, not a failure
    if (r.status !== 0) return true;   // any nonzero exit is a failure
    if (!r.parsed) return true;        // no report ⇒ treat as failure
    return r.entries.some((e) => !e.success);
  });
}

function productIdsFromSelection(selection: UserSelection): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const p of [...selection.addedDeps, ...selection.products]) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      ids.push(p.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Legacy direct-install path (used when the user selects zero CLIs)
// ---------------------------------------------------------------------------

async function legacyInstall(selection: UserSelection): Promise<void> {
  console.log(chalk.bold("\nInstalling (direct)...\n"));
  const all = [...selection.addedDeps, ...selection.products]; // deps first
  const results: InstallResult[] = [];

  for (const product of all) {
    process.stdout.write(`  ${chalk.cyan("→")} ${product.displayName}... `);
    const result = await installProduct(product);
    results.push(result);

    if (result.skipped) {
      console.log(chalk.yellow("manual steps required"));
    } else if (result.success) {
      console.log(chalk.green("done"));
    } else {
      console.log(chalk.red("failed"));
    }
  }

  console.log(chalk.bold("\nSummary:"));
  for (const r of results) {
    const icon = r.skipped ? chalk.yellow("?") : r.success ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${r.message}`);
  }

  const failures = results.filter((r) => !r.success && !r.skipped);
  const manuals = results.filter((r) => r.skipped);

  if (manuals.length > 0) {
    console.log(chalk.yellow("\nManual installation required:"));
    for (const r of manuals) {
      const p = getProduct(r.productId);
      if (p?.install.instructions) {
        console.log(chalk.dim(`\n  ${p.displayName}:`));
        console.log(chalk.dim(`  ${p.install.instructions}`));
      }
    }
  }

  if (failures.length > 0) {
    console.log(chalk.red(`\n${failures.length} installation(s) failed. Check output above for details.`));
    process.exit(1);
  } else {
    console.log(chalk.green("\nDone! Start your coding agent to activate the installed tools."));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runInteractive(flags: DispatchFlags): Promise<void> {
  console.log(
    boxen(
      `${chalk.bold.cyan("wicked-*")} installer  ${chalk.dim(`v${VERSION}`)}\n` +
      chalk.dim("Registry-driven installer for the wicked-* AI developer ecosystem"),
      { padding: 1, borderColor: "cyan", borderStyle: "round" }
    )
  );

  // Registered CLIs = the install scripts shipped next to this one (§14 offer rule).
  const cliOptions: CliOption[] = discoverCliScripts(__dirname).map((script) => {
    const presence = detectCli(script.cli);
    return {
      cli: script.cli,
      displayName: presence.displayName,
      scriptPath: script.scriptPath,
      detected: presence.detected,
      binOnPath: presence.binOnPath,
      homeDetected: presence.homeDetected,
    };
  });

  const detected = cliOptions.filter((o) => o.detected);
  if (detected.length > 0) {
    console.log(chalk.dim(`\nDetected CLIs: ${detected.map((o) => chalk.white(o.displayName)).join(", ")}`));
  } else if (cliOptions.length > 0) {
    console.log(chalk.yellow("\nNo CLIs detected — you can still install (their homes will be created)."));
  } else {
    console.log(chalk.yellow("\nNo per-CLI install scripts found; will use the direct-install path."));
  }
  console.log();

  try {
    const mode = await promptSelectionMode();
    const selection = mode === "bundle" ? await promptBundle() : await promptCustom();
    const confirmed = await promptConfirm(selection);

    if (!confirmed) {
      console.log(chalk.dim("\nInstallation cancelled."));
      process.exit(0);
    }

    let selectedClis: CliOption[] = [];
    if (cliOptions.length > 0) {
      selectedClis = await promptClis(cliOptions);
    }

    if (selectedClis.length === 0) {
      // Zero CLIs selected (or none available) → legacy behavior.
      await legacyInstall(selection);
      return;
    }

    const productIds = productIdsFromSelection(selection);
    const code = await dispatchToClis(selectedClis, productIds, flags);
    if (code !== 0) process.exit(code);
  } catch (err) {
    // Inquirer throws on Ctrl+C
    if (err instanceof Error && err.message.includes("force closed")) {
      console.log(chalk.dim("\nCancelled."));
      process.exit(0);
    }
    throw err;
  }
}

async function runList(): Promise<void> {
  const products = listProducts(true);
  console.log(chalk.bold("Available wicked-* products:\n"));
  for (const p of products) {
    const badge = p.status === "design" ? chalk.gray(` [${p.status}]`) :
                  p.status === "preview" ? chalk.yellow(` [${p.status}]`) :
                  p.status === "active" ? chalk.cyan(` [${p.status}]`) :
                  chalk.green(` [${p.status}]`);
    console.log(`  ${chalk.bold(p.id)}${badge}`);
    console.log(`  ${chalk.dim(p.description)}`);
    if (p.requires.length > 0) console.log(`  ${chalk.dim("requires:")} ${p.requires.join(", ")}`);
    console.log();
  }
}

async function runInstallDirect(productIds: string[]): Promise<void> {
  const { resolve } = await import("./resolver.js");
  const { selected, added, blocked } = resolve(productIds);

  if (blocked.length > 0) {
    console.error(chalk.red(`Unknown products: ${blocked.join(", ")}`));
    process.exit(1);
  }

  if (added.length > 0) {
    console.log(chalk.cyan(`Adding required dependencies: ${added.map(p => p.displayName).join(", ")}\n`));
  }

  const all = [...added, ...selected];
  for (const product of all) {
    process.stdout.write(`Installing ${product.displayName}... `);
    const result = await installProduct(product);
    if (result.skipped) {
      console.log(chalk.yellow("manual steps required"));
      if (product.install.instructions) console.log(chalk.dim(`  ${product.install.instructions}`));
    } else if (result.success) {
      console.log(chalk.green("done"));
    } else {
      console.log(chalk.red("failed"));
      console.error(chalk.dim(`  ${result.message}`));
    }
  }
}

async function runStatus(): Promise<void> {
  const { isProductInstalled } = await import("./detector.js");
  const products = listProducts(true);

  const clis = detectClis();
  console.log(chalk.bold("Detected CLIs:"));
  if (clis.length === 0) {
    console.log(chalk.dim("  none detected"));
  } else {
    for (const c of clis) {
      console.log(`  ${chalk.green("✓")} ${c.displayName}${c.version ? chalk.dim(` (${c.version})`) : ""}`);
    }
  }

  console.log(chalk.bold("\nwicked-* products:"));
  for (const p of products) {
    const installed = isProductInstalled(p.id);
    const statusIcon = installed ? chalk.green("✓ installed") :
                       p.install.type === "manual" ? chalk.yellow("~ manual") :
                       chalk.dim("  not installed");
    const statusBadge = p.status === "design" ? chalk.gray(` [${p.status}]`) : "";
    console.log(`  ${statusIcon}  ${chalk.bold(p.id)}${statusBadge}`);
  }
}

function printHelp(): void {
  console.log([
    `wicked-installer v${VERSION}`,
    "",
    "Usage:",
    "  wicked-installer                 Interactive install (pick products, then CLIs)",
    "  wicked-installer list            List available products",
    "  wicked-installer install <ids>   Install specific products (space-separated, direct)",
    "  wicked-installer status          Show detected CLIs and installed products",
    "  wicked-installer --version       Show version",
    "",
    "Flags (interactive):",
    "  --dry-run                        Show what each CLI script would do, write nothing",
    "  --force                          Pass --force through to per-CLI install scripts",
  ].join("\n"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const flags: DispatchFlags = {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
  };
  const positional = argv.filter((a) => !a.startsWith("-"));
  const cmd = positional[0];
  const rest = positional.slice(1);

  switch (cmd) {
    case "list":
      await runList();
      break;
    case "status":
      await runStatus();
      break;
    case "install":
      if (rest.length === 0) {
        console.error(chalk.red("Specify at least one product id. Use 'list' to see options."));
        process.exit(1);
      }
      await runInstallDirect(rest);
      break;
    default:
      await runInteractive(flags);
  }
}

/** True when this file is the process entrypoint (not imported for testing). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(err => {
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
