export type ProductStatus = "stable" | "active" | "preview" | "design" | "retired";
export type ProductType = "npm-cli" | "npm-lib" | "mcp-binary" | "claude-plugin" | "desktop-binary";
export type InstallType = "npm-global" | "npm-run" | "binary" | "manual" | "github-binary" | "git-plugin" | "cargo";

export interface InstallAction {
  type: InstallType;
  package?: string;
  command?: string;
  args?: string[];
  instructions?: string;
  githubRepo?: string;       // owner/repo — for github-binary
  assetPattern?: string;     // regex to match release asset filename
  mcpInstructions?: string;  // shown after install
  repo?: string;             // full git URL — for git-plugin
  dest?: string;             // install destination relative to home
  postInstallCmd?: string;   // command to run after main install step
  crate?: string;            // crates.io crate name — for cargo
  version?: string;          // exact version to pin — for cargo (omit for latest)
}

export interface Product {
  id: string;
  displayName: string;
  description: string;
  type: ProductType;
  standalone: boolean;
  opinionated: boolean;
  status: ProductStatus;
  requires: string[];
  recommended?: string[];
  install: InstallAction;
  note?: string;
}

export interface Bundle {
  id: string;
  displayName: string;
  description: string;
  products: string[];
}

export interface Registry {
  version: string;
  products: Product[];
  bundles: Bundle[];
}

export interface InstallResult {
  productId: string;
  success: boolean;
  skipped: boolean;
  message: string;
}

export interface DetectedCli {
  id: string;
  displayName: string;
  version?: string;
}

/**
 * May this product be installed?
 *
 * `design` is unbuilt; `retired` is gone — wicked-testing and wicked-brain are both
 * npm-DEPRECATED, so installing one hands the operator a package whose own registry entry
 * tells them to use something else instead.
 *
 * Lives here, beside {@link ProductStatus}, because it is a fact about the status and has no
 * dependencies. It was previously written out THREE times and one copy drifted: the two `--all`
 * paths filtered only `design`, so `--all` installed both retired products. The duplication was
 * the bug; one definition is the fix.
 */
export function isInstallable(p: { status: ProductStatus }): boolean {
  return p.status !== "design" && p.status !== "retired";
}
