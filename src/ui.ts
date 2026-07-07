import { select, checkbox, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { listProducts, listBundles } from "./registry.js";
import { resolve } from "./resolver.js";
import type { Product } from "./types.js";

const STATUS_BADGE: Record<string, string> = {
  stable: chalk.green("[stable]"),
  active: chalk.cyan("[active]"),
  preview: chalk.yellow("[preview]"),
  design: chalk.gray("[design]"),
};

export type SelectionMode = "bundle" | "custom";

export interface UserSelection {
  products: Product[];
  addedDeps: Product[];
}

export async function promptSelectionMode(): Promise<SelectionMode> {
  return select({
    message: "How would you like to install?",
    choices: [
      { name: "Choose a bundle  (recommended starting points)", value: "bundle" },
      { name: "Custom selection  (pick individual products)", value: "custom" },
    ],
  }) as Promise<SelectionMode>;
}

export async function promptBundle(): Promise<UserSelection> {
  const bundles = listBundles();

  const bundleId = await select({
    message: "Choose a bundle:",
    choices: bundles.map(b => ({
      name: `${chalk.bold(b.displayName)}  —  ${chalk.dim(b.description)}`,
      value: b.id,
    })),
  });

  const bundle = bundles.find(b => b.id === bundleId)!;
  const { selected, added, blocked } = resolve(bundle.products);

  if (blocked.length > 0) {
    console.log(chalk.yellow(`\nWarning: could not resolve: ${blocked.join(", ")}`));
  }

  return { products: selected, addedDeps: added };
}

export async function promptCustom(): Promise<UserSelection> {
  const products = listProducts(false);

  const choices = products.map(p => ({
    name: `${chalk.bold(p.displayName)}  ${STATUS_BADGE[p.status] ?? ""}  —  ${chalk.dim(p.description)}${p.opinionated ? chalk.magenta("  [bundle — all or nothing]") : ""}`,
    value: p.id,
    checked: false,
  }));

  const selected = await checkbox({
    message: "Select products to install (space to toggle, enter to confirm):",
    choices,
    validate: (input: readonly unknown[]) => input.length > 0 ? true : "Select at least one product",
  });

  const { selected: resolved, added, blocked } = resolve(selected);

  if (blocked.length > 0) {
    console.log(chalk.yellow(`\nWarning: could not resolve dependencies: ${blocked.join(", ")}`));
  }

  if (added.length > 0) {
    console.log(
      chalk.cyan(`\nAdding required dependencies: ${added.map(p => p.displayName).join(", ")}`)
    );
  }

  return { products: resolved, addedDeps: added };
}

export async function promptConfirm(selection: UserSelection): Promise<boolean> {
  const all = [...selection.products, ...selection.addedDeps];
  const manualItems = all.filter(p => p.install.type === "manual" || p.install.type === "binary");

  console.log(chalk.bold("\nSelected for installation:"));
  for (const p of selection.products) {
    const badge = p.install.type === "manual" ? chalk.yellow(" (manual steps)") : "";
    console.log(`  ${chalk.green("+")} ${p.displayName}${badge}`);
  }
  if (selection.addedDeps.length > 0) {
    console.log(chalk.dim("\n  Auto-added dependencies:"));
    for (const p of selection.addedDeps) {
      console.log(`  ${chalk.dim("+")} ${chalk.dim(p.displayName)}`);
    }
  }
  if (manualItems.length > 0) {
    console.log(chalk.yellow(`\n  Note: ${manualItems.map(p => p.displayName).join(", ")} require manual steps.`));
  }

  return confirm({ message: "\nProceed with installation?" });
}
