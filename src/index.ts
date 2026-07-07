#!/usr/bin/env node
import chalk from "chalk";
import boxen from "boxen";
import { detectClis } from "./detector.js";
import { installProduct } from "./installer.js";
import { promptSelectionMode, promptBundle, promptCustom, promptConfirm } from "./ui.js";
import { listProducts, getProduct } from "./registry.js";
import type { InstallResult } from "./types.js";

const VERSION = "0.1.0";

async function runInteractive(): Promise<void> {
  console.log(
    boxen(
      `${chalk.bold.cyan("wicked-*")} installer  ${chalk.dim(`v${VERSION}`)}\n` +
      chalk.dim("Registry-driven installer for the wicked-* AI developer ecosystem"),
      { padding: 1, borderColor: "cyan", borderStyle: "round" }
    )
  );

  // CLI detection
  const clis = detectClis();
  if (clis.length > 0) {
    console.log(chalk.dim(`\nDetected CLIs: ${clis.map(c => chalk.white(c.displayName)).join(", ")}`));
  } else {
    console.log(chalk.yellow("\nNo supported CLIs detected. Install Claude Code, Cursor, or another supported CLI first."));
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

    console.log(chalk.bold("\nInstalling...\n"));
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

    // Summary
    console.log(chalk.bold("\nSummary:"));
    for (const r of results) {
      const icon = r.skipped ? chalk.yellow("?") : r.success ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} ${r.message}`);
    }

    const failures = results.filter(r => !r.success && !r.skipped);
    const manuals = results.filter(r => r.skipped);

    if (manuals.length > 0) {
      console.log(chalk.yellow("\nManual installation required:"));
      for (const r of results.filter(r => r.skipped)) {
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
  const { detectClis, isProductInstalled } = await import("./detector.js");
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

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "--help":
    case "-h":
      console.log([
        `wicked-installer v${VERSION}`,
        "",
        "Usage:",
        "  wicked-installer                 Interactive install",
        "  wicked-installer list            List available products",
        "  wicked-installer install <ids>   Install specific products (space-separated)",
        "  wicked-installer status          Show detected CLIs and installed products",
        "  wicked-installer --version       Show version",
      ].join("\n"));
      break;
    case "list":
      await runList();
      break;
    case "status":
      await runStatus();
      break;
    case "install":
      if (args.length === 0) {
        console.error(chalk.red("Specify at least one product id. Use 'list' to see options."));
        process.exit(1);
      }
      await runInstallDirect(args);
      break;
    default:
      await runInteractive();
  }
}

main().catch(err => {
  console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
