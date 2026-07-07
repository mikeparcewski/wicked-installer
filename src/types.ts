export type ProductStatus = "stable" | "active" | "preview" | "design";
export type ProductType = "npm-cli" | "npm-lib" | "mcp-binary" | "claude-plugin" | "desktop-binary";
export type InstallType = "npm-global" | "npm-run" | "binary" | "manual" | "github-binary" | "git-plugin";

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
