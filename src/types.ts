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
  crate?: string;            // crates.io crate name — for cargo; when `crates` is present, names the product's primary (MCP) binary
  crates?: string[];         // for cargo products that ship >1 crate (e.g. wicked-estate + wicked-estate-mcp); wins over `crate` for acquisition
  version?: string;          // exact version to pin — for cargo (omit for latest)
  marketplace?: string;      // claude-plugin: what `claude plugin marketplace add` receives (GitHub owner/repo, URL, or path); default mikeparcewski/<id>
  pluginId?: string;         // claude-plugin: `<plugin>@<marketplace>` for `claude plugin install|update`; default <id>@<id>
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
  /** Retired products only: the products that absorbed it, named when one is requested. */
  successors?: string[];
  /** What each capability needs at runtime, checked read-only after install (src/readiness.ts). */
  capabilities?: Capability[];
}

/**
 * One runtime capability a product delivers and what it needs to actually run. "Copied" or
 * "registered" says what the installer did; whether the capability is READY is a separate
 * question answered by checking these needs (EXP-01).
 */
export interface Capability {
  id: string;
  label: string;
  /** CLI slugs this capability is delivered to (absent ⇒ every target). */
  hosts?: string[];
  /** Pending here is reported, never a blocker for the rest of the product. */
  optional?: boolean;
  needs: CapabilityNeed[];
}

export type CapabilityNeed =
  /** An executable on PATH. `npx` names the package an `npx` fallback would fetch (and `npm i -g` installs); `product` is the registry id whose install provides it when there is no npm package; `doctor` is a read-only self-check subcommand that prints `{ "ok": bool }` JSON. */
  | { kind: "launcher" | "backend"; bin: string; npx?: string; doctor?: string[]; product?: string }
  /** A Python 3 interpreter (python3 → python → py -3) at or above `min`. */
  | { kind: "python"; min: string };

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
  planned?: boolean;         // --dry-run: the plan was printed and nothing ran
  // claude-plugin products: how the install ended — registered with Claude Code, planned (dry-run,
  // Claude Code present), or the bare-copy fallback (no Claude Code CLI). Absent for other products.
  registration?: "registered" | "planned" | "fallback" | "manual";
}

export interface DetectedCli {
  id: string;
  displayName: string;
  version?: string;
  /** Set when the PATH probe could not check (an fs error, not "absent") — shown, never dropped (#28). */
  unverified?: string;
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

/**
 * Why a product that was asked for BY NAME (or pulled in through `requires`) is refused, or
 * `undefined` when it may be installed. Only `retired` is refused: a retired product is gone, so
 * the answer names what replaced it rather than installing a deprecated package. `design` stays
 * the explicit-id escape hatch INTERFACE.md §4 documents (those rows are `manual`).
 *
 * This file imports nothing, so every install script imports it (INTERFACE.md §15) — the same
 * predicate decides `--all`, the defaults and explicit ids on every CLI path.
 */
export function retiredRefusal(
  p: { id: string; status: ProductStatus; successors?: string[]; description?: string },
  requiredBy?: string,
): string | undefined {
  if (p.status !== "retired") return undefined;
  const via = requiredBy ? ` (required by ${requiredBy})` : "";
  // The description says where the capabilities went; its "RETIRED (date)." lead-in is noise here.
  const where = (p.description ?? "").replace(/^RETIRED\s*(\([^)]*\))?\.?\s*/i, "");
  const successors = Array.isArray(p.successors) && p.successors.length > 0
    ? ` Successors: ${p.successors.join(", ")}.`
    : "";
  return `${p.id} is retired and is not installed${via}.${where ? ` ${where}` : ""}${successors}`;
}
