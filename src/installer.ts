import { execa } from "execa";
import type { Product, InstallResult } from "./types.js";

export async function installProduct(product: Product): Promise<InstallResult> {
  const { id, displayName, install } = product;

  try {
    switch (install.type) {
      case "npm-global": {
        if (!install.package) throw new Error("install.package required for npm-global");
        await execa("npm", ["install", "-g", install.package], { stdio: "inherit" });
        return { productId: id, success: true, skipped: false, message: `${displayName} installed globally via npm` };
      }

      case "npm-run": {
        if (!install.package) throw new Error("install.package required for npm-run");
        const cmd = install.command ?? "install";
        const args = install.args ?? [];
        await execa("npx", [install.package, cmd, ...args], { stdio: "inherit" });
        return { productId: id, success: true, skipped: false, message: `${displayName} installed via npx ${install.package} ${cmd}` };
      }

      case "manual": {
        return {
          productId: id,
          success: true,
          skipped: true,
          message: install.instructions ?? `${displayName} requires manual installation.`,
        };
      }

      case "binary": {
        return {
          productId: id,
          success: true,
          skipped: true,
          message: install.instructions ?? `${displayName} requires binary download.`,
        };
      }

      default:
        return { productId: id, success: false, skipped: false, message: `Unknown install type: ${(install as { type: string }).type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { productId: id, success: false, skipped: false, message: `Failed: ${message}` };
  }
}
