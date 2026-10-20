#!/usr/bin/env node
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// The one sanctioned shared module (INTERFACE.md §15): dependency-free lifecycle predicate.
import { isInstallable, retiredRefusal } from "./types.js";

type ProductStatus = "stable" | "active" | "preview" | "design" | "retired";
type ProductType = "npm-cli" | "npm-lib" | "mcp-binary" | "claude-plugin" | "desktop-binary";
type InstallType = "npm-global" | "npm-run" | "binary" | "manual" | "github-binary" | "git-plugin" | "cargo";

interface InstallAction {
  type: InstallType;
  package?: string;
  command?: string;
  args?: string[];
  instructions?: string;
  githubRepo?: string;
  assetPattern?: string;
  mcpInstructions?: string;
  repo?: string;
  dest?: string;
  crate?: string;
  crates?: string[];
  version?: string;
  codexPlugin?: boolean;
}

interface Product {
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
  successors?: string[];
}

interface Registry {
  version: string;
  products: Product[];
}

interface Options {
  productIds: string[];
  all: boolean;
  codexHome: string;
  registryPath: string;
  sourceRoot: string;
  dryRun: boolean;
  json: boolean;
  force: boolean;
  skipBinaries: boolean;
  pruneLegacySkills: boolean;
  /** Install a codexPlugin product's npm package even under --skip-binaries (the dispatcher's
   *  "binaries already acquired" does not cover it: no other CLI installs that package). */
  pluginPackages: boolean;
}

interface AssetCounts {
  skills: number;
}

interface InstallReport {
  productId: string;
  displayName: string;
  success: boolean;
  skipped: boolean;
  message: string;
  delivery?: Delivery;
  pending?: string[];
  assets: AssetCounts;
  notes: string[];
  /** Loose skill directories this run copied into <codexHome>/skills (the copy path). */
  skills?: string[];
  /** The Codex plugin this run registered (the plugin path). */
  codexPlugin?: CodexPluginRecord;
}

/** What the plugin path registered, kept in the marker so a re-run can tell its own marketplace. */
interface CodexPluginRecord {
  pluginId: string;
  marketplace: string;
  /** The marketplace root the plugin was installed from (a local directory). */
  source: string;
  version: string;
  /** false when the marketplace was configured by someone else and only used. */
  addedByInstaller: boolean;
  /** false when the plugin is disabled (then nothing was changed and nothing is pruned). */
  enabled?: boolean;
}

/** One product entry of the v1 marker, plus the additive keys this script now records. */
interface MarkerProduct {
  id: string;
  success?: boolean;
  skipped?: boolean;
  assets?: { skills?: number };
  notes?: string[];
  skills?: string[];
  codexPlugin?: CodexPluginRecord;
  [key: string]: unknown;
}

interface PackageSource {
  root: string;
  cleanup?: string;
  source: "local" | "npm-pack" | "git";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKIP_BINARY_EXTS = /\.(md|txt|sha256|sha512|asc|json|toml|yaml|yml|xml|html|css|js|ts)$/i;
const COPY_SKIP_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

function existingDirs(paths: string[]): string[] {
  return [...new Set(paths.filter((dir) => existsSync(dir)))];
}

function codexAssetDirs(root: string, leaf: string): string[] {
  return existingDirs([join(root, leaf), join(root, ".claude", leaf)]);
}

function defaultRegistryPath(): string {
  const packaged = join(__dirname, "..", "registry.json");
  if (existsSync(packaged)) return packaged;
  return resolve(process.cwd(), "registry.json");
}

function findDefaultSourceRoot(): string {
  const candidates = [
    resolve(__dirname, "..", ".."),
    resolve(process.cwd(), ".."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "wicked-installer", "registry.json"))) return candidate;
    if (existsSync(join(candidate, "wicked-testing", "package.json"))) return candidate;
  }
  return process.cwd();
}

function expandHome(path: string): string {
  return path.replace(/^~(?=$|[/\\])/, homedir());
}

function parseArgs(argv: string[]): Options {
  const productIds: string[] = [];
  let all = false;
  let codexHome = process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : join(homedir(), ".codex");
  let registryPath = defaultRegistryPath();
  let sourceRoot = process.env.WICKED_SOURCE_ROOT
    ? expandHome(process.env.WICKED_SOURCE_ROOT)
    : findDefaultSourceRoot();
  let dryRun = false;
  let json = false;
  let force = false;
  let skipBinaries = false;
  let pruneLegacySkills = false;
  let pluginPackages = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--skip-binaries") {
      skipBinaries = true;
    } else if (arg === "--prune-legacy-skills") {
      pruneLegacySkills = true;
    } else if (arg === "--plugin-packages") {
      pluginPackages = true;
    } else if (arg === "--codex-home" && argv[i + 1]) {
      i += 1;
      codexHome = expandHome(argv[i]);
    } else if (arg.startsWith("--codex-home=")) {
      codexHome = expandHome(arg.slice("--codex-home=".length));
    } else if (arg === "--registry" && argv[i + 1]) {
      i += 1;
      registryPath = expandHome(argv[i]);
    } else if (arg.startsWith("--registry=")) {
      registryPath = expandHome(arg.slice("--registry=".length));
    } else if (arg === "--source-root" && argv[i + 1]) {
      i += 1;
      sourceRoot = expandHome(argv[i]);
    } else if (arg.startsWith("--source-root=")) {
      sourceRoot = expandHome(arg.slice("--source-root=".length));
    } else if (arg === "--products" && argv[i + 1]) {
      i += 1;
      productIds.push(...argv[i].split(",").map((id) => id.trim()).filter(Boolean));
    } else if (arg.startsWith("--products=")) {
      productIds.push(...arg.slice("--products=".length).split(",").map((id) => id.trim()).filter(Boolean));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      productIds.push(arg);
    }
  }

  return {
    productIds,
    all,
    codexHome: resolve(codexHome),
    registryPath: resolve(registryPath),
    sourceRoot: resolve(sourceRoot),
    dryRun,
    json,
    force,
    skipBinaries,
    pruneLegacySkills,
    pluginPackages,
  };
}

function printHelp(): void {
  console.log([
    "wicked-installer Codex install piece",
    "",
    "Usage:",
    "  install-codex <product ids...>",
    "  install-codex --products wicked-bus,wicked-estate",
    "  install-codex --all",
    "",
    "Options:",
    "  --codex-home <dir>    Codex home to write into (default: $CODEX_HOME or ~/.codex)",
    "  --registry <file>     Registry JSON path",
    "  --source-root <dir>   Local wicked-* checkout root, used before npm pack",
    "  --skip-binaries      Copy Codex assets without npm/cargo binary installation",
    "  --dry-run            Print what would happen without writing",
    "  --json               Emit machine-readable report",
    "  --force              Re-add the Codex plugin even when it is current; repoint a",
    "                       wicked-garden marketplace another source configured",
    "  --prune-legacy-skills Also remove <product>-* loose skills that a marker written",
    "                       before skill names were recorded cannot attribute",
    "  --plugin-packages    Under --skip-binaries, still install a Codex-plugin product's",
    "                       npm package (the picker passes it: that package is the plugin)",
    "",
    "Codex with `codex plugin` (0.163+): a product that ships .codex-plugin/plugin.json",
    "(wicked-garden) is registered as a plugin through a local marketplace at its",
    "installed package, and the loose skills this installer copied earlier are removed.",
    "Older Codex: skills are copied into <codex-home>/skills as before.",
  ].join("\n"));
}

function loadRegistry(path: string): Registry {
  const data = JSON.parse(readFileSync(path, "utf8")) as Registry;
  if (!Array.isArray(data.products)) {
    throw new Error(`invalid registry: ${path}`);
  }
  return data;
}

function resolveProducts(registry: Registry, ids: string[], all: boolean): Product[] {
  const byId = new Map(registry.products.map((product) => [product.id, product]));
  // One predicate for every CLI path (src/types.ts): `--all` takes only installable products,
  // and a retired product — named or pulled in through `requires` — is refused with its
  // successors rather than acquired.
  const requested = all
    ? registry.products.filter(isInstallable).map((product) => product.id)
    : ids;

  if (requested.length === 0) {
    throw new Error("no products selected; pass product ids or --all");
  }

  const out: Product[] = [];
  const seen = new Set<string>();

  function add(id: string, requiredBy?: string): void {
    if (seen.has(id)) return;
    const product = byId.get(id);
    if (!product) throw new Error(`unknown product: ${id}`);
    const refusal = retiredRefusal(product, requiredBy);
    if (refusal) throw new Error(refusal);
    seen.add(id);
    for (const req of product.requires) add(req, id);
    out.push(product);
  }

  for (const id of requested) add(id);
  return out;
}

function log(options: Options, message: string): void {
  if (!options.json) console.log(message);
}

function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0;
}

function run(cmd: string, args: string[], options: Options, cwd?: string, capture = false): string {
  const rendered = [cmd, ...args].join(" ");
  if (options.dryRun) {
    log(options, `  dry-run: ${rendered}${cwd ? `  (cwd: ${cwd})` : ""}`);
    return "";
  }
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stderr || result.stdout || ""}`.trim() : "";
    throw new Error(`${rendered} failed${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function ensureCodexHome(options: Options): void {
  const dirs = [
    options.codexHome,
    join(options.codexHome, "skills"),
  ];
  if (options.dryRun) {
    for (const dir of dirs) log(options, `  dry-run: mkdir -p ${dir}`);
    return;
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  accessSync(options.codexHome, fsConstants.W_OK);
}

function installProductBinaries(product: Product, options: Options): string[] {
  const install = product.install;
  const notes: string[] = [];

  if (options.skipBinaries) {
    notes.push("binary/package installation skipped by --skip-binaries");
    return notes;
  }

  switch (install.type) {
    case "npm-global": {
      if (!install.package) throw new Error(`${product.id}: install.package required`);
      run("npm", ["install", "-g", install.package], options);
      break;
    }
    case "npm-run": {
      if (!install.package) throw new Error(`${product.id}: install.package required`);
      notes.push(`Codex assets installed directly; not running ${install.package} ${install.command ?? "install"} because package installers may target other CLIs`);
      break;
    }
    case "cargo": {
      // A product may ship more than one crate (install.crates), e.g. wicked-estate +
      // wicked-estate-mcp — one without the other is a broken install.
      const singleCrate = install.crate ?? install.package;
      const crates = Array.isArray(install.crates) && install.crates.length > 0
        ? install.crates
        : singleCrate ? [singleCrate] : [];
      if (crates.length === 0) throw new Error(`${product.id}: install.crate required`);
      if (!commandExists("cargo")) {
        throw new Error("cargo not found; install Rust from https://rustup.rs and retry");
      }
      // `--version` only pins a single crate; with several, pin per-crate via name@version.
      const names = install.version && crates.length > 1
        ? crates.map((c) => `${c}@${install.version}`)
        : crates;
      const args = ["install", ...names];
      if (install.version && crates.length === 1) args.push("--version", install.version);
      run("cargo", args, options);
      break;
    }
    case "github-binary": {
      installGithubBinary(product, options);
      break;
    }
    case "manual":
    case "binary": {
      notes.push(install.instructions ?? `${product.displayName} requires manual installation`);
      break;
    }
    case "git-plugin": {
      notes.push("git plugin assets copied directly for Codex");
      break;
    }
    default: {
      const neverInstall: never = install.type;
      throw new Error(`unsupported install type: ${neverInstall}`);
    }
  }

  if (install.mcpInstructions) notes.push(install.mcpInstructions);
  return notes;
}

function cargoBinaryPath(crateOrBinary: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(homedir(), ".cargo", "bin", `${crateOrBinary}${suffix}`);
}

function installGithubBinary(product: Product, options: Options): void {
  const install = product.install;
  if (!install.githubRepo) throw new Error(`${product.id}: install.githubRepo required`);

  const platform = process.platform;
  const arch = process.arch;
  const osName: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archName: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
  const os = osName[platform] ?? platform;
  const cpu = archName[arch] ?? arch;

  const releaseJson = run(
    "node",
    [
      "-e",
      "const u=process.argv[1];fetch(u).then(async r=>{if(!r.ok)throw new Error(String(r.status));process.stdout.write(await r.text())}).catch(e=>{console.error(e.message);process.exit(1)})",
      `https://api.github.com/repos/${install.githubRepo}/releases/latest`,
    ],
    options,
    undefined,
    true,
  );
  if (options.dryRun) return;

  const release = JSON.parse(releaseJson) as { assets?: Array<{ name: string; browser_download_url: string }> };
  const assets = release.assets ?? [];
  const pattern = install.assetPattern
    ? new RegExp(install.assetPattern)
    : new RegExp(`${os}.*${cpu}|${cpu}.*${os}`, "i");
  const asset = assets.find((candidate) => pattern.test(candidate.name) && !candidate.name.endsWith(".sha256"));
  if (!asset) throw new Error(`no ${os}-${cpu} asset found in ${install.githubRepo}`);

  const binDir = join(homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, product.id);
  const tmp = mkdtempSync(join(tmpdir(), `wicked-codex-${product.id}-`));

  try {
    const archive = join(tmp, asset.name);
    run(
      "node",
      [
        "-e",
        "const u=process.argv[1],p=process.argv[2];fetch(u).then(async r=>{if(!r.ok)throw new Error(String(r.status));require('fs').writeFileSync(p,Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e.message);process.exit(1)})",
        asset.browser_download_url,
        archive,
      ],
      options,
    );

    if (/\.(tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$/i.test(asset.name)) {
      if (asset.name.endsWith(".zip") && process.platform !== "win32") {
        run("unzip", ["-o", archive, "-d", tmp], options);
      } else {
        run("tar", ["-xf", archive, "-C", tmp], options);
      }
      const binary = findBinary(tmp, product.id, asset.name);
      if (!binary) throw new Error(`no binary found in ${asset.name}`);
      renameSync(binary, dest);
    } else {
      cpSync(archive, dest, { force: true });
    }
    chmodSync(dest, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Codex CLI calls. Every one carries CODEX_HOME = the target home (so --codex-home is honoured
// and the operator's own ~/.codex is never touched by a run aimed elsewhere), and goes through
// mcpSpawn, which applies the Windows .cmd-shim recipe (§1.1).
// ---------------------------------------------------------------------------

function codexEnv(options: Options): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: options.codexHome };
}

function codex(args: string[], options: Options): { status: number | null; out: string; stdout?: string; error?: string } {
  if (!existsSync(options.codexHome)) {
    // codex refuses a CODEX_HOME that does not exist; only a --dry-run reaches here without one.
    return { status: null, out: "", error: `codex home ${options.codexHome} does not exist` };
  }
  return mcpSpawn("codex", args, codexEnv(options), 180000);
}

function codexJson<T>(args: string[], options: Options): T | undefined {
  const r = codex(args, options);
  if (r.error || r.status !== 0) return undefined;
  const text = r.stdout ?? r.out;
  try {
    return JSON.parse(text.slice(text.indexOf("{"))) as T;
  } catch {
    return undefined;
  }
}

function homeTilde(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + "/") || p.startsWith(home + "\\") ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// The wicked-estate MCP binary: one resolution for the estate registration and the garden
// plugin's repair. Same order as garden's own resolver (WICKED_ESTATE_MCP_BIN → PATH →
// ~/.local/bin) with ~/.cargo/bin last (where `cargo install` puts it even when it is not on
// PATH). Among the copies found, the highest `wicked-estate --version` (the CLI next to it;
// the MCP binary prints none) wins; an explicit WICKED_ESTATE_MCP_BIN always wins.
// ---------------------------------------------------------------------------

interface EstateCandidate { path: string; version?: string; source: string }
interface EstateResolution { chosen?: EstateCandidate; candidates: EstateCandidate[]; warnings: string[] }

/** Names to probe for `name`: on Windows the PATHEXT forms first (a bare file is not runnable there). */
function exeNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return exts.map((e) => name + e.toLowerCase());
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** shutil.which's test (garden's resolver uses it for PATH): a file this user may execute. */
function isExecutableFile(p: string): boolean {
  if (!isRegularFile(p)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read-only probe, also under --dry-run (it writes nothing). */
function estateVersionNextTo(mcpBin: string): string | undefined {
  const dir = dirname(mcpBin);
  for (const name of exeNames("wicked-estate")) {
    const cli = join(dir, name);
    if (!isExecutableFile(cli)) continue;
    const r = mcpSpawn(cli, ["--version"], process.env, 10000);
    const m = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(r.stdout ?? "");
    if (!r.error && r.status === 0 && m) return m[1];
  }
  return undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return norm(a) === norm(b);
}

function pathDirs(): string[] {
  return (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

/**
 * What garden's plugin launcher (scripts/estate_mcp.mjs, = `_estate_client.resolve_mcp_bin`)
 * would start: WICKED_ESTATE_MCP_BIN if a file → the first executable on PATH → ~/.local/bin.
 */
function pluginLauncherResolves(envOverlay: Record<string, string> | null | undefined = undefined): string | undefined {
  const name = "wicked-estate-mcp";
  // A config entry's own env (`[mcp_servers.x.env]`) is what the launcher sees first.
  const env = { ...process.env, ...(envOverlay ?? {}) };
  const override = env.WICKED_ESTATE_MCP_BIN;
  if (override && isRegularFile(override)) return override;
  const dirs = (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const n of exeNames(name)) if (isExecutableFile(join(dir, n))) return join(dir, n);
  }
  for (const n of [name, `${name}.exe`]) if (isRegularFile(join(homedir(), ".local", "bin", n))) return join(homedir(), ".local", "bin", n);
  return undefined;
}

function resolveEstateMcpBinary(name = "wicked-estate-mcp", overrideEnv: string | null = "WICKED_ESTATE_MCP_BIN"): EstateResolution {
  const seen = new Set<string>();
  const candidates: EstateCandidate[] = [];
  const add = (rawPath: string, source: string, needExec: boolean) => {
    const p = resolve(rawPath); // a relative PATH entry must not become a relative MCP command
    if (needExec ? !isExecutableFile(p) : !isRegularFile(p)) return;
    let key = p;
    try {
      key = realpathSync(p);
    } catch {
      /* keep the path */
    }
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: p, source });
  };
  const override = overrideEnv ? process.env[overrideEnv] : undefined;
  if (override && overrideEnv) add(resolve(expandHome(override)), overrideEnv, false);
  for (const dir of pathDirs()) for (const n of exeNames(name)) add(join(dir, n), "PATH", true);
  for (const n of exeNames(name)) add(join(homedir(), ".local", "bin", n), "~/.local/bin", false);
  add(cargoBinaryPath(name), "~/.cargo/bin", true);

  const warnings: string[] = [];
  if (candidates.length === 0) return { candidates, warnings };
  // Versions come from the estate CLI next to the binary; other products have no such probe.
  if (name === "wicked-estate-mcp") for (const c of candidates) c.version = estateVersionNextTo(c.path);
  const explicit = overrideEnv ? candidates.find((c) => c.source === overrideEnv) : undefined;
  let chosen = explicit ?? candidates[0];
  if (!explicit) {
    for (const c of candidates) {
      if (c.version && (!chosen.version || compareVersions(c.version, chosen.version) > 0)) chosen = c;
    }
  }
  const cargoDir = dirname(cargoBinaryPath(name));
  const firstOnPath = candidates.find((c) => c.source === "PATH");
  for (const c of candidates) {
    if (c === chosen || dirname(c.path) !== cargoDir) continue;
    const older = c.version && chosen.version && compareVersions(c.version, chosen.version) < 0;
    if (!older) continue;
    const shadows = firstOnPath === c;
    warnings.push(
      `stale ${homeTilde(c.path)} (${c.version}) ${shadows ? "shadows" : "is older than"} ${homeTilde(chosen.path)} (${chosen.version})` +
      (shadows ? " on PATH — anything that runs the bare name `wicked-estate-mcp` gets the stale copy" : "") +
      "; upgrade it with `cargo install wicked-estate wicked-estate-mcp` or delete it",
    );
  }
  return { chosen, candidates, warnings };
}

interface CodexMcpTransport { type?: string; command?: string; args?: unknown[]; env?: Record<string, string> | null; env_vars?: unknown[] | null; cwd?: string | null }
interface CodexMcpServer {
  enabled?: boolean;
  transport?: CodexMcpTransport;
  enabled_tools?: unknown;
  disabled_tools?: unknown;
  startup_timeout_sec?: unknown;
  tool_timeout_sec?: unknown;
}

function codexMcpGet(name: string, options: Options): { state: "absent" } | { state: "present"; server: CodexMcpServer; transport: CodexMcpTransport } | { state: "error"; detail: string } {
  // A home that does not exist yet (a --dry-run before the first install) holds no server.
  if (!existsSync(options.codexHome)) return { state: "absent" };
  const r = codex(["mcp", "get", name, "--json"], options);
  if (r.error) return { state: "error", detail: r.error };
  if (r.status !== 0) {
    if (/no mcp server named/i.test(r.out)) return { state: "absent" };
    return { state: "error", detail: `codex mcp get ${name} exited ${r.status}: ${r.out.trim().slice(0, 300)}` };
  }
  try {
    const text = r.stdout ?? r.out;
    const server = JSON.parse(text.slice(text.indexOf("{"))) as CodexMcpServer;
    return { state: "present", server, transport: server.transport ?? {} };
  } catch {
    return { state: "error", detail: `codex mcp get ${name} --json printed no JSON` };
  }
}

// ---------------------------------------------------------------------------
// Repairing a Codex config-tier MCP entry. `codex mcp add` rewrites the WHOLE entry from
// command/args/--env and drops everything else (cwd, env_vars, enabled, required, tool lists,
// approval modes, timeouts — and `codex mcp get --json` does not even show all of those), so an
// existing entry is never rewritten through it. Instead the one `command = …` line of
// `[mcp_servers.<name>]` in <codexHome>/config.toml is replaced in place (mechanism 1 with a
// stated target, INTERFACE.md §8.3; verified against codex-cli 0.163.0): backup, atomic write,
// then `codex mcp get --json` must show the new command and every other visible field unchanged,
// or the backup is restored. A new entry (none in config.toml) is created with `codex mcp add`.
// ---------------------------------------------------------------------------

type ConfigTable = { lines: string[]; commandLine: number } | "none" | { ambiguous: string };

// A small TOML reader for exactly what the repair needs: the decoded key path of every table
// header and key/value line (bare, "basic" with escapes, 'literal' segments), with values,
// multi-line strings and multi-line arrays skipped correctly and comments ignored. Anything it
// cannot read is an error, which the caller turns into "ambiguous" (never into "absent").

class TomlScanError extends Error {}

const TRIPLE_BASIC = '"""';
const TRIPLE_LITERAL = "'''";

/** Decode one key path starting at `pos`; returns the segments and where it ended. */
function scanKeyPath(line: string, pos: number): { path: string[]; end: number } {
  const path: string[] = [];
  let i = pos;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i += 1;
    const c = line[i];
    if (c === '"') {
      let out = "";
      i += 1;
      for (;;) {
        const ch = line[i];
        if (ch === undefined) throw new TomlScanError("unterminated quoted key");
        if (ch === '"') { i += 1; break; }
        if (ch === "\\") {
          const e = line[i + 1];
          const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\u001b" };
          if (e in simple) { out += simple[e]; i += 2; continue; }
          const hexLen = e === "u" ? 4 : e === "U" ? 8 : e === "x" ? 2 : 0;
          const hex = line.slice(i + 2, i + 2 + hexLen);
          if (!hexLen || hex.length !== hexLen || !/^[0-9A-Fa-f]+$/.test(hex)) throw new TomlScanError("bad escape in key");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2 + hexLen;
          continue;
        }
        out += ch;
        i += 1;
      }
      path.push(out);
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new TomlScanError("unterminated literal key");
      path.push(line.slice(i + 1, close));
      i = close + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!m) throw new TomlScanError("bad key");
      path.push(m[0]);
      i += m[0].length;
    }
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (line[i] === ".") { i += 1; continue; }
    return { path, end: i };
  }
}

/** Where an unescaped `"""` closes a multi-line basic string on this line, or -1. */
function tripleBasicClose(line: string, from: number): number {
  for (let i = from; i < line.length; i += 1) {
    if (line[i] === "\\") { i += 1; continue; }
    if (line.startsWith(TRIPLE_BASIC, i)) return i;
  }
  return -1;
}

/** Bracket depth after scanning `line` from `pos` (strings and comments respected). */
function scanBrackets(line: string, pos: number, depth: number): number {
  // A multi-line string inside an array is beyond this reader: refuse rather than guess.
  if (line.includes(TRIPLE_BASIC, pos) || line.includes(TRIPLE_LITERAL, pos)) throw new TomlScanError("multi-line string inside an array");
  for (let i = pos; i < line.length; i += 1) {
    const c = line[i];
    if (c === "#") break;
    if (c === '"') {
      for (i += 1; i < line.length && line[i] !== '"'; i += 1) if (line[i] === "\\") i += 1;
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      i = close < 0 ? line.length : close;
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
  }
  return depth;
}

type OpenValue = { kind: "basic3" | "literal3" } | { kind: "array"; depth: number };

/** A value that continues past its line (a multi-line string or array), else undefined. */
function openValueAfter(line: string, pos: number): OpenValue | undefined {
  let i = pos;
  while (line[i] === " " || line[i] === "\t") i += 1;
  if (line.startsWith(TRIPLE_BASIC, i)) return tripleBasicClose(line, i + 3) >= 0 ? undefined : { kind: "basic3" };
  if (line.startsWith(TRIPLE_LITERAL, i)) return line.indexOf(TRIPLE_LITERAL, i + 3) >= 0 ? undefined : { kind: "literal3" };
  if (line[i] === "[") {
    const depth = scanBrackets(line, i, 0);
    return depth > 0 ? { kind: "array", depth } : undefined;
  }
  return undefined;
}

/**
 * Locate `[mcp_servers.<name>]` (any key spelling, escapes decoded) and its single-line
 * `command = "…"` in config.toml text. Conservative: any OTHER way the server could be
 * defined — dotted keys, a key or inline table under `[mcp_servers]`, an inline `mcp_servers`,
 * a repeated table, only subtables, an array of tables, a multi-line command, or a line the
 * reader cannot parse — is `ambiguous`, never `none`, so nothing that might be an existing
 * entry is ever treated as absent and overwritten.
 */
function findConfigServerTable(text: string, name: string): ConfigTable {
  const lines = text.split("\n");
  const starts: number[] = [];
  let sawSubtable = false;
  let table: string[] = [];
  let open: OpenValue | undefined;
  let commandLine = -1;
  let badCommand = false;
  const isServer = (path: string[]) => path.length >= 2 && path[0] === "mcp_servers" && path[1] === name;
  try {
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i].replace(/\r$/, "");
      if (open) {
        if (open.kind === "array") {
          const depth = scanBrackets(l, 0, open.depth);
          open = depth > 0 ? { kind: "array", depth } : undefined;
        } else if (open.kind === "basic3" ? tripleBasicClose(l, 0) >= 0 : l.includes(TRIPLE_LITERAL)) {
          open = undefined;
        }
        continue;
      }
      if (/^\s*(#|$)/.test(l)) continue;
      const lead = l.search(/\S/);
      if (l[lead] === "[") {
        const arrayTable = l[lead + 1] === "[";
        const { path, end } = scanKeyPath(l, lead + (arrayTable ? 2 : 1));
        const close = arrayTable ? "]]" : "]";
        if (!l.startsWith(close, end) || !/^\s*(#.*)?$/.test(l.slice(end + close.length))) throw new TomlScanError("bad table header");
        table = path;
        if (arrayTable && path[0] === "mcp_servers" && (path.length === 1 || path[1] === name)) return { ambiguous: "mcp_servers uses an array of tables" };
        if (isServer(path)) {
          if (path.length === 2) starts.push(i);
          else sawSubtable = true;
        }
        continue;
      }
      const { path, end } = scanKeyPath(l, lead);
      if (l[end] !== "=") throw new TomlScanError("expected = after a key");
      const full = [...table, ...path];
      open = openValueAfter(l, end + 1);
      // The server's own `command` key (any key spelling), read in this same pass so a
      // multi-line value elsewhere in the table can never be mistaken for a key.
      if (table.length === 2 && isServer(table) && path.length === 1 && path[0] === "command") {
        if (open || !commandValueSpan(l) || commandLine >= 0) badCommand = true;
        commandLine = i;
      }
      if (full.length === 1 && full[0] === "mcp_servers") return { ambiguous: "mcp_servers is an inline table" };
      // A key of the server from outside its own tables (dotted keys, an inline table under
      // [mcp_servers]) — inside [mcp_servers.<name>] or one of its subtables it is ordinary.
      if (isServer(full) && !isServer(table)) {
        return { ambiguous: `${name} is defined in a form other than one [mcp_servers.${name}] table` };
      }
    }
  } catch (err) {
    return { ambiguous: `config.toml could not be read safely (${err instanceof Error ? err.message : String(err)})` };
  }
  if (open) return { ambiguous: "config.toml ends inside a multi-line value" };
  if (starts.length > 1) return { ambiguous: `[mcp_servers.${name}] appears ${starts.length} times` };
  if (starts.length === 0) return sawSubtable ? { ambiguous: `only subtables of [mcp_servers.${name}] exist` } : "none";
  if (badCommand) return { ambiguous: `the command line of [mcp_servers.${name}] is not a single quoted string` };
  if (commandLine < 0) return { ambiguous: `[mcp_servers.${name}] has no command line` };
  return { lines, commandLine };
}

/**
 * The `command = <string>` line split as prefix (key spelling kept) / value / suffix (comment
 * kept), when the value is a single-line basic or literal string; else undefined.
 */
function commandValueSpan(line: string): { prefix: string; suffix: string } | undefined {
  const { end } = scanKeyPath(line, line.search(/\S/));
  if (line[end] !== "=") return undefined;
  const m = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/.exec(line.slice(end + 1));
  if (!m || m[2].startsWith(TRIPLE_BASIC) || m[2].startsWith(TRIPLE_LITERAL)) return undefined;
  return { prefix: line.slice(0, end + 1) + m[1], suffix: m[3] };
}

/** JSON with object keys sorted at every level (Codex prints map keys in no fixed order). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Everything `codex mcp get --json` shows, minus the command — must not change in a repair. */
function visibleSettings(s: CodexMcpServer): string {
  const { command: _command, ...transport } = s.transport ?? {};
  void _command;
  return canonicalJson({ ...s, transport });
}

/**
 * Point the config-tier entry `name` at `binary`. Returns the note; throws only when Codex
 * cannot be asked at all. Never deletes an entry, never drops a setting.
 */
function pointCodexMcpAt(name: string, binary: string, version: string | undefined, current: { state: "absent" } | { state: "present"; server: CodexMcpServer; transport: CodexMcpTransport }, options: Options, canonicalBinary: string = binary): string {
  const label = `${homeTilde(binary)}${version ? ` (${version})` : ""}`;
  const configPath = join(options.codexHome, "config.toml");
  // A config.toml that is a symlink (dotfile managers) is edited at its target, so the link stays.
  let configFile = configPath;
  try {
    configFile = realpathSync(configPath);
  } catch {
    /* absent: nothing to resolve */
  }
  const text = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const table = findConfigServerTable(text, name);
  if (typeof table === "object" && "ambiguous" in table) {
    return `Codex MCP server ${name}: not changed (${table.ambiguous}) — point its command at ${binary} in ${homeTilde(configPath)}`;
  }
  if (table === "none") {
    if (current.state === "present" && isConfigTier(current.transport)) {
      return `Codex MCP server ${name}: -> ${homeTilde(String(current.transport.command ?? "?"))} comes from a config layer other than ${homeTilde(configPath)}; left as it is`;
    }
    if (options.dryRun) return `would register Codex MCP server ${name} -> ${label}`;
    // Nothing configured for this name: a fresh entry has no settings to lose.
    const add = codex(["mcp", "add", name, "--", binary], options);
    if (add.error || add.status !== 0) throw new Error(`codex mcp add ${name} failed: ${add.error ?? add.out.trim().slice(0, 300)}`);
    return `registered Codex MCP server ${name} -> ${label}`;
  }
  if (current.state === "present" && current.transport.command === binary) return `Codex MCP server ${name}: config entry already -> ${label}`;
  const was = current.state === "present" ? homeTilde(String(current.transport.command ?? "?")) : "?";
  // Only an entry that runs the estate binary itself is repointed: a wrapper (npx, node, a
  // shell script) takes arguments meant for itself, which the bare binary would not accept.
  const exe = (p: string) => (p.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
  // The product's canonical executable name decides, not the replacement's (an override may be
  // a renamed download).
  const runsBinary = current.state === "present" && (exe(String(current.transport.command ?? "")) === exe(canonicalBinary) || current.transport.command === binary);
  if (!runsBinary) {
    return `Codex MCP server ${name}: not changed (its command ${was} is not the ${exe(canonicalBinary)} binary) — point it at ${binary} yourself if it should run that`;
  }
  if (options.dryRun) return `would repair Codex MCP server ${name}: ${was} -> ${label} (only its command line changes)`;
  const raw = table.lines[table.commandLine];
  const cr = raw.endsWith("\r") ? "\r" : "";
  const span = commandValueSpan(raw.replace(/\r$/, ""));
  if (!span) return `Codex MCP server ${name}: not changed (unexpected command line)`;
  const lines = [...table.lines];
  lines[table.commandLine] = `${span.prefix}${JSON.stringify(binary)}${span.suffix}${cr}`;
  // The new file keeps the old one's permission bits (config.toml may hold secrets: 0600 stays 0600).
  const written = lines.join("\n");
  const mode = statSync(configFile).mode & 0o777;
  const backup = `${configFile}.wicked-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const tmp = `${configFile}.wicked-tmp-${process.pid}`;
  writeFileSync(tmp, written, { mode });
  chmodSync(tmp, mode);
  // Optimistic concurrency: another writer (a running Codex) may have changed the file since it
  // was read. Then nothing is written — re-running repairs against the new content.
  if (readFileSync(configFile, "utf8") !== text) {
    rmSync(tmp, { force: true });
    return `Codex MCP server ${name}: not changed — config.toml changed while it was being repaired; re-run to repair it`;
  }
  cpSync(configFile, backup);
  chmodSync(backup, mode);
  // Re-check the LIVE file after the backup (and the backup itself): another writer in between
  // keeps its change and nothing is written. A writer in the instant before the rename is not
  // detectable without a lock Codex does not offer.
  if (readFileSync(backup, "utf8") !== text || readFileSync(configFile, "utf8") !== text) {
    // Another writer got in between the check and the backup: keep theirs, write nothing.
    rmSync(tmp, { force: true });
    rmSync(backup, { force: true });
    return `Codex MCP server ${name}: not changed — config.toml changed while it was being repaired; re-run to repair it`;
  }
  renameSync(tmp, configFile);
  const after = codexMcpGet(name, options);
  const ok = after.state === "present" && after.transport.command === binary
    && (current.state !== "present" || visibleSettings(after.server) === visibleSettings(current.server));
  if (!ok) {
    // Put the old file back only if the file is still exactly what this repair wrote.
    if (readFileSync(configFile, "utf8") === written) {
      renameSync(backup, configFile);
      return `Codex MCP server ${name}: repair to ${label} not kept — Codex did not read it back unchanged, the previous config.toml was restored`;
    }
    return `Codex MCP server ${name}: repair to ${label} not verified, and config.toml has changed since — left as it is; the pre-repair copy is ${homeTilde(backup)}`;
  }
  rmSync(backup, { force: true });
  return `repaired Codex MCP server ${name}: ${was} -> ${label} (only its command line changed)`;
}

function registerCodexMcp(product: Product, options: Options): string[] {
  const notes: string[] = [];
  if (product.type !== "mcp-binary") return notes;
  if (!commandExists("codex")) {
    throw new Error("codex CLI not found; cannot register MCP server");
  }

  // The estate resolver (override, newest version, shadow warning) is wicked-estate's; any other
  // mcp-binary product resolves its own binary by name (PATH → ~/.local/bin → ~/.cargo/bin).
  const binaryName = product.install.crate ?? product.install.package ?? product.id;
  const estate = product.id === "wicked-estate";
  const resolution = estate ? resolveEstateMcpBinary() : resolveEstateMcpBinary(binaryName, null);
  notes.push(...resolution.warnings);
  const chosen = resolution.chosen;
  if (!chosen) {
    throw new Error(`no ${binaryName} binary found (${estate ? "WICKED_ESTATE_MCP_BIN, " : ""}PATH, ~/.local/bin, ~/.cargo/bin)`);
  }
  const current = codexMcpGet(product.id, options);
  if (current.state === "error") throw new Error(current.detail);
  if (estate && current.state === "present" && isLauncherEntry(current.transport)) {
    // garden's launcher resolves the binary itself (and adds --readonly where it must).
    const launcher = pluginLauncherResolves();
    notes.push(`Codex MCP server ${product.id}: runs garden's estate launcher (it resolves the binary at start and adds --readonly where it must) — left as it is; it would start ${launcher ? homeTilde(launcher) : "nothing (not on PATH or in ~/.local/bin)"}${launcher && samePath(launcher, chosen.path) ? "" : `, not ${homeTilde(chosen.path)} — put ${homeTilde(dirname(chosen.path))} first on PATH or set WICKED_ESTATE_MCP_BIN`}`);
    return notes;
  }
  notes.push(pointCodexMcpAt(product.id, chosen.path, chosen.version, current, options, estate ? "wicked-estate-mcp" : binaryName));
  return notes;
}

function stringArgs(args: unknown): string[] {
  return Array.isArray(args) ? args.map(String) : [];
}

/**
 * The garden plugin's declaration of the estate server (`.codex-plugin/mcp.json`). `codex mcp
 * get` shows the EFFECTIVE server, so this is how a plugin-served entry is told from a config one.
 */
const PLUGIN_ESTATE_SERVERS: Array<{ command: string; args: string[] }> = [
  { command: "wicked-garden", args: ["run", "scripts/estate_mcp.mjs"] },
];

/** An entry that runs garden's estate launcher (`wicked-garden run scripts/estate_mcp.mjs`). */
function isLauncherEntry(t: CodexMcpTransport): boolean {
  const args = stringArgs(t.args);
  const script = (args[1] ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  return /(^|[\\/])wicked-garden(\.cmd)?$/i.test(String(t.command ?? "")) && args[0] === "run" && script === "scripts/estate_mcp.mjs";
}

function isConfigTier(t: CodexMcpTransport): boolean {
  const args = JSON.stringify(stringArgs(t.args));
  return !PLUGIN_ESTATE_SERVERS.some((p) => t.command === p.command && args === JSON.stringify(p.args));
}

/**
 * After the garden plugin is registered. The plugin declares `wicked-estate` itself, and its
 * launcher resolves the binary at start (override → PATH → ~/.local/bin) and applies the
 * read-only / governed-unit rules, so it always stays in the path: a launcher-served entry is
 * never repointed, and when the launcher would not start the current binary the PATH /
 * WICKED_ESTATE_MCP_BIN fix is reported. Only a config entry that runs the binary directly is
 * repaired (its command line).
 */
function repairEstateForPlugin(options: Options): string[] {
  const notes: string[] = [];
  const resolution = resolveEstateMcpBinary();
  notes.push(...resolution.warnings);
  const chosen = resolution.chosen;
  const current = codexMcpGet("wicked-estate", options);
  if (current.state === "error") {
    notes.push(`wicked-estate MCP not checked: ${current.detail}`);
    return notes;
  }
  // Whether a config entry exists is read from config.toml itself — a user entry may look
  // exactly like the plugin's (`wicked-garden run scripts/estate_mcp.mjs`).
  const configFile = join(options.codexHome, "config.toml");
  const table = findConfigServerTable(existsSync(configFile) ? readFileSync(configFile, "utf8") : "", "wicked-estate");
  const homeEntry = table !== "none";
  if (!homeEntry && current.state === "absent" && !options.dryRun) {
    notes.push("wicked-estate MCP: Codex reports no wicked-estate server (is the garden plugin enabled?)");
    return notes;
  }
  // Served through garden's launcher: the plugin's own server, or a config entry that runs the
  // same launcher. Either resolves the binary at start, so neither is ever repointed.
  const pluginServed = (!homeEntry && !(current.state === "present" && isConfigTier(current.transport)))
    || (current.state === "present" && isLauncherEntry(current.transport) && !(typeof table === "object" && "ambiguous" in table));
  if (!chosen) {
    notes.push(pluginServed
      ? "wicked-estate MCP: served by the plugin, but no wicked-estate-mcp is installed yet — `npx wicked-installer install wicked-estate`"
      : "wicked-estate MCP: config entry kept; no wicked-estate-mcp binary resolves to repair it with");
    return notes;
  }
  if (pluginServed) {
    // The plugin's launcher stays in the path: it is what adds --readonly for
    // WICKED_ESTATE_READONLY / run markers and refuses an unpinned governed unit. A config entry
    // that runs the binary directly would bypass that, so none is written; the fix is reported.
    const entryEnv = homeEntry && current.state === "present" ? current.transport.env : undefined;
    const launcher = pluginLauncherResolves(entryEnv);
    if (launcher && samePath(launcher, chosen.path)) {
      notes.push(`wicked-estate MCP: served by the plugin; its launcher starts ${homeTilde(chosen.path)}${chosen.version ? ` (${chosen.version})` : ""}`);
    } else {
      const pinnedInEntry = !!entryEnv && ("WICKED_ESTATE_MCP_BIN" in entryEnv || "PATH" in entryEnv);
      notes.push(`wicked-estate MCP: served by garden's launcher, but it would start ${launcher ? homeTilde(launcher) : "nothing (not on PATH or in ~/.local/bin)"}, not ${homeTilde(chosen.path)}${chosen.version ? ` (${chosen.version})` : ""} — ` +
        (pinnedInEntry
          ? `its [mcp_servers.wicked-estate.env] sets WICKED_ESTATE_MCP_BIN/PATH: point that at ${chosen.path}`
          : `put ${homeTilde(dirname(chosen.path))} first on PATH, or set WICKED_ESTATE_MCP_BIN=${chosen.path} in the environment Codex starts from`));
    }
    return notes;
  }
  notes.push(pointCodexMcpAt("wicked-estate", chosen.path, chosen.version, current, options, "wicked-estate-mcp"));
  const runsBinaryNow = current.state === "present" && /(^|[\\/])wicked-estate-mcp(\.exe)?$/i.test(String(current.transport.command ?? ""));
  if (runsBinaryNow && isConfigTier(current.transport) && !(typeof table === "object" && "ambiguous" in table)) {
    notes.push("wicked-estate MCP: this config entry runs the binary directly and overrides the plugin's server (whose launcher adds --readonly for WICKED_ESTATE_READONLY and run markers); `codex mcp remove wicked-estate` lets the plugin serve it");
  }
  return notes;
}

function findBinary(dir: string, productId: string, archiveName: string): string | undefined {
  const priority: string[] = [];
  const rest: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = findBinary(full, productId, archiveName);
      if (sub) rest.push(sub);
    } else if (entry.isFile() && entry.name !== archiveName && !SKIP_BINARY_EXTS.test(entry.name)) {
      if (entry.name === productId || entry.name === `${productId}-mcp` || entry.name.startsWith(productId)) {
        priority.push(full);
      } else {
        rest.push(full);
      }
    }
  }
  return priority[0] ?? rest[0];
}

function productPackageName(product: Product): string | undefined {
  return product.install.package ?? product.install.crate ?? product.id;
}

function localProductRoot(product: Product, options: Options): string | undefined {
  const candidates = [
    join(options.sourceRoot, product.id),
    join(options.sourceRoot, productPackageName(product) ?? product.id),
  ];
  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "package.json")) ||
      codexAssetDirs(candidate, "skills").length > 0
    ) {
      return candidate;
    }
  }
  return undefined;
}

function stageProduct(product: Product, options: Options): PackageSource | undefined {
  const local = localProductRoot(product, options);
  if (local) return { root: local, source: "local" };

  if (product.install.type === "git-plugin" && product.install.repo) {
    const tmp = mkdtempSync(join(tmpdir(), `wicked-codex-${product.id}-`));
    const dest = join(tmp, "repo");
    run("git", ["clone", "--depth", "1", product.install.repo, dest], options);
    return { root: dest, cleanup: tmp, source: "git" };
  }

  const packageName = product.install.package;
  if (!packageName || options.dryRun) return undefined;

  const tmp = mkdtempSync(join(tmpdir(), `wicked-codex-${product.id}-`));
  try {
    const output = run("npm", ["pack", packageName, "--json", "--pack-destination", tmp], options, undefined, true);
    const packed = JSON.parse(output) as Array<{ filename?: string }>;
    const filename = packed[0]?.filename;
    if (!filename) throw new Error(`npm pack did not return a filename for ${packageName}`);
    const tarball = join(tmp, filename);
    run("tar", ["-xzf", tarball, "-C", tmp], options);
    return { root: join(tmp, "package"), cleanup: tmp, source: "npm-pack" };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function shouldCopy(src: string): boolean {
  if (basename(src) === ".DS_Store") return false;
  const parts = src.split(/[\\/]/);
  return !parts.some((part) => COPY_SKIP_SEGMENTS.has(part));
}

function copyTree(src: string, dest: string, options: Options): void {
  if (options.dryRun) {
    log(options, `  dry-run: copy ${src} -> ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: shouldCopy,
  });
}

function readSkillName(skillDir: string): string | undefined {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return undefined;
  const body = readFileSync(skillFile, "utf8");
  return body.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
}

function codexSkillName(productId: string, name: string, rel: string): string {
  if (name.startsWith("wicked-") || name.includes(":")) return name;
  const suffix = name || rel.replace(/[\\/]+/g, "-");
  return `${productId}-${suffix}`;
}

function sanitizePathPart(value: string): string {
  return value
    .replace(/[:/\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function rewriteCopiedSkillName(dest: string, originalName: string | undefined, nextName: string, options: Options): void {
  if (!originalName || originalName === nextName || options.dryRun) return;
  const skillFile = join(dest, "SKILL.md");
  if (!existsSync(skillFile)) return;
  const body = readFileSync(skillFile, "utf8");
  const updated = body.replace(
    /^name:\s*["']?([^"'\n]+)["']?\s*$/m,
    `name: ${nextName}`,
  );
  writeFileSync(skillFile, updated);
}

function findSkillRoots(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  const roots: string[] = [];

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const direct = join(skillsDir, entry.name);
    if (existsSync(join(direct, "SKILL.md"))) {
      roots.push(direct);
      continue;
    }
    roots.push(...findSkillRootsRecursive(direct));
  }

  return roots;
}

function findSkillRootsRecursive(dir: string): string[] {
  const roots: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(full, "SKILL.md"))) {
      roots.push(full);
    } else {
      roots.push(...findSkillRootsRecursive(full));
    }
  }
  return roots;
}

function collectSkillRoots(root: string): string[] {
  const roots = new Set<string>();
  for (const skillsDir of codexAssetDirs(root, "skills")) {
    for (const skillRoot of findSkillRoots(skillsDir)) {
      roots.add(skillRoot);
    }
  }
  return [...roots];
}

/** Copy every skill root into <codexHome>/skills; returns the destination directory names. */
function copySkills(product: Product, root: string, options: Options): string[] {
  const roots = collectSkillRoots(root);
  const names: string[] = [];

  for (const skillRoot of roots) {
    const skillsDir = codexAssetDirs(root, "skills").find((dir) => skillRoot.startsWith(dir)) ?? join(root, "skills");
    const rel = relative(skillsDir, skillRoot);
    const originalName = readSkillName(skillRoot);
    const nextName = codexSkillName(product.id, originalName ?? "", rel);
    const dirName = sanitizePathPart(nextName);
    const dest = join(options.codexHome, "skills", dirName);
    copyTree(skillRoot, dest, options);
    rewriteCopiedSkillName(dest, originalName, nextName, options);
    names.push(dirName);
  }

  return names;
}

function markerPath(options: Options): string {
  return join(options.codexHome, "wicked-installer", "codex-install.json");
}

/**
 * The marker a previous run left, or undefined. An unreadable marker is reported, never
 * guessed at: nothing it might have recorded is pruned.
 */
function readInstallMarker(options: Options): { products: MarkerProduct[]; warning?: string } | undefined {
  const file = markerPath(options);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { products?: unknown };
    const products = Array.isArray(parsed?.products)
      ? (parsed.products as unknown[]).filter((p): p is MarkerProduct => !!p && typeof p === "object" && typeof (p as MarkerProduct).id === "string")
      : [];
    return { products };
  } catch (err) {
    return { products: [], warning: `codex marker ${file} unreadable (${err instanceof Error ? err.message : String(err)}); nothing it recorded is pruned` };
  }
}

/**
 * Write the v1 marker. Entries for products this run did not touch are KEPT (a run for one
 * product no longer erases what an earlier run recorded about another — the record pruning
 * depends on). Additive keys: `skills` (loose skill dirs copied) and `codexPlugin`.
 */
function writeInstallMarker(options: Options, reports: InstallReport[], previous: MarkerProduct[]): void {
  const file = markerPath(options);
  const touched = new Set(reports.map((r) => r.productId));
  const entries: MarkerProduct[] = previous.filter((p) => !touched.has(p.id));
  for (const report of reports) {
    const prior = previous.find((p) => p.id === report.productId);
    if (!report.success && prior) {
      // A failed run proves nothing about what is on disk: keep the earlier entry (its ownership
      // evidence included) and note the failure beside it.
      entries.push({ ...prior, lastFailure: { at: new Date().toISOString(), message: report.message } });
      continue;
    }
    const entry: MarkerProduct = {
      id: report.productId,
      success: report.success,
      skipped: report.skipped,
      assets: report.assets,
      notes: report.notes,
    };
    // With an unreadable previous marker, ownership is unknown: record no `skills` list (it would
    // read as "owns nothing" next time).
    if (report.skills && !markerUnreadable) entry.skills = report.skills;
    if (report.codexPlugin) entry.codexPlugin = report.codexPlugin;
    entries.push(entry);
  }
  const body = {
    installedAt: new Date().toISOString(),
    codexHome: options.codexHome,
    products: entries,
  };

  if (options.dryRun) {
    log(options, `  dry-run: write ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (markerUnreadable && existsSync(file)) {
    // Keep the unreadable marker for the operator instead of overwriting it.
    renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  const tmp = `${file}.wicked-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * What this script delivered, in one word (EXP-01): `registered` = wired into the host (an MCP
 * server), `copied` = skill files placed but nothing registered, `acquired` = a binary only,
 * `manual` = a step the operator performs, `planned` = --dry-run. Whether a capability is then READY is a separate,
 * read-only check (`wicked-installer status`, src/readiness.ts).
 */
type Delivery = "registered" | "copied" | "acquired" | "manual" | "planned";

/**
 * Runtime this script deliberately did not provision. An `npm-run` product's skills reach its
 * scripts only through that package's launcher, which this script never installs — say so when
 * the launcher is not already on PATH instead of reporting the copy as a finished install.
 */
function runtimePending(product: Product): string[] {
  const pkg = product.install.package;
  if (product.install.type !== "npm-run" || !pkg || commandExists(pkg)) return [];
  return [`${pkg} launcher not on PATH — script-backed skills are pending: run \`npm i -g ${pkg}\` (the \`npx ${pkg}\` fallback needs the network at first use)`];
}

// ---------------------------------------------------------------------------
// Codex plugin path (codex-cli with `codex plugin`, 0.163+). A product that ships
// `.codex-plugin/plugin.json` and a marketplace manifest is registered through a LOCAL
// marketplace whose root is a durable copy of the product — a --source-root checkout, or the
// globally installed npm package — never a temp staging dir (Codex keeps reading the
// marketplace root after the install). `codex plugin add` then copies it into
// <codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/.
// ---------------------------------------------------------------------------

const MARKETPLACE_MANIFESTS = [
  // Codex's discovery order (codex-rs/core-plugins/src/marketplace.rs).
  join(".agents", "plugins", "marketplace.json"),
  join(".agents", "plugins", "api_marketplace.json"),
  join(".claude-plugin", "marketplace.json"),
  join(".cursor-plugin", "marketplace.json"),
];

let pluginSupportCache: boolean | undefined;
/** Set when the previous marker could not be read: ownership is unknown, so nothing is pruned. */
let markerUnreadable = false;

/** Does this codex have `codex plugin` with JSON output? Read-only probe. */
function codexSupportsPlugins(options: Options): boolean {
  if (pluginSupportCache !== undefined) return pluginSupportCache;
  if (!commandExists("codex")) return (pluginSupportCache = false);
  const r = mcpSpawn("codex", ["plugin", "list", "--help"], codexEnv(options));
  pluginSupportCache = r.status === 0 && /--json/.test(r.out) && /--available/.test(r.out);
  return pluginSupportCache;
}

interface PluginSource {
  root: string;
  kind: "local" | "npm-global";
  pluginName: string;
  version: string;
  marketplace: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The plugin + marketplace a root declares for Codex, or why it does not qualify. */
function pluginSourceAt(root: string, kind: PluginSource["kind"]): PluginSource | string {
  const manifest = readJson(join(root, ".codex-plugin", "plugin.json"));
  if (!manifest) return `${homeTilde(root)} has no .codex-plugin/plugin.json`;
  const pluginName = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (!pluginName || !version) return `${homeTilde(join(root, ".codex-plugin", "plugin.json"))} has no name/version`;
  for (const rel of MARKETPLACE_MANIFESTS) {
    const mkt = readJson(join(root, rel));
    if (!mkt) continue;
    const plugins = Array.isArray(mkt.plugins) ? mkt.plugins as Array<Record<string, unknown>> : [];
    if (typeof mkt.name !== "string" || !plugins.some((p) => p && p.name === pluginName)) {
      return `${homeTilde(join(root, rel))} does not list ${pluginName}`;
    }
    return { root, kind, pluginName, version, marketplace: mkt.name };
  }
  return `${homeTilde(root)} has no marketplace manifest`;
}

function npmGlobalRoot(): string | undefined {
  const r = mcpSpawn("npm", ["root", "-g"], process.env);
  if (r.error || r.status !== 0) return undefined;
  const line = (r.stdout ?? r.out).split(/\r?\n/).map((l) => l.trim()).find((l) => isAbsolute(l));
  return line || undefined;
}

/**
 * Where the plugin's marketplace root lives: a --source-root checkout first (development),
 * else the global npm package (`npm install -g <pkg>` first, unless --skip-binaries/--dry-run).
 */
function resolvePluginSource(product: Product, options: Options, notes: string[]): PluginSource | "planned" | undefined {
  // A "local source" that is really the global npm package (a globally installed installer's
  // default source root is that node_modules) takes the npm path, so it is refreshed.
  const localCandidate = localProductRoot(product, options);
  const globalRootNow = product.install.codexPlugin === true ? npmGlobalRoot() : undefined;
  const local = localCandidate && globalRootNow && samePath(dirname(localCandidate), globalRootNow) ? undefined : localCandidate;
  if (local) {
    const found = pluginSourceAt(local, "local");
    if (typeof found !== "string") return found;
    // The requested local source wins: it is copied as before, nothing is installed globally.
    notes.push(`local source not usable as a Codex plugin: ${found}`);
    return undefined;
  }
  const pkg = product.install.package;
  // Only a product the registry marks as a Codex plugin is ever installed globally for it.
  if (product.install.type !== "npm-run" || !pkg || product.install.codexPlugin !== true) return undefined;
  const installPackage = !options.skipBinaries || options.pluginPackages;
  if (installPackage) {
    if (options.dryRun) {
      log(options, `  dry-run: npm install -g ${pkg}`);
    } else {
      const r = mcpSpawn("npm", ["install", "-g", pkg], process.env, 600000);
      if (r.error || r.status !== 0) throw new Error(`npm install -g ${pkg} failed: ${r.error ?? r.out.trim().slice(-300)}`);
      notes.push(`npm install -g ${pkg}`);
    }
  }
  const globalRoot = npmGlobalRoot();
  if (!globalRoot) {
    notes.push("npm root -g did not answer; no installed package to register");
    return undefined;
  }
  const root = join(globalRoot, pkg);
  if (!existsSync(root)) {
    if (options.dryRun && installPackage) {
      // The real run installs it first; say what would follow instead of planning the copy path.
      notes.push(`${pkg} is not installed globally yet; a real run installs it, then registers it as a Codex plugin from ${homeTilde(root)} if that release ships .codex-plugin/`);
      return "planned";
    }
    notes.push(`${pkg} is not installed globally (${homeTilde(root)})`);
    return undefined;
  }
  const found = pluginSourceAt(root, "npm-global");
  if (typeof found === "string") {
    if (options.dryRun && installPackage) {
      notes.push(`installed ${pkg} is not a Codex plugin (${found}); a real run upgrades it first, then registers it as a Codex plugin if the new release ships .codex-plugin/`);
      return "planned";
    }
    notes.push(`installed ${pkg} is not a Codex plugin: ${found}`);
    return undefined;
  }
  return found;
}

/** `[plugins."<id>"] enabled` from config.toml: true / false, or undefined when not readable. */
function configPluginEnabled(options: Options, pluginId: string): boolean | undefined {
  const file = join(options.codexHome, "config.toml");
  if (!existsSync(file)) return undefined;
  let table: string[] = [];
  let found: boolean | undefined;
  let open: OpenValue | undefined;
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const l = raw.replace(/\r$/, "");
      if (open) {
        if (open.kind === "array") {
          const depth = scanBrackets(l, 0, open.depth);
          open = depth > 0 ? { kind: "array", depth } : undefined;
        } else if (open.kind === "basic3" ? tripleBasicClose(l, 0) >= 0 : l.includes(TRIPLE_LITERAL)) {
          open = undefined;
        }
        continue;
      }
      if (/^\s*(#|$)/.test(l)) continue;
      const lead = l.search(/\S/);
      if (l[lead] === "[") {
        table = scanKeyPath(l, lead + (l[lead + 1] === "[" ? 2 : 1)).path;
        continue;
      }
      const { path, end } = scanKeyPath(l, lead);
      if (l[end] === "=") open = openValueAfter(l, end + 1);
      if (table.length !== 2 || table[0] !== "plugins" || table[1] !== pluginId) continue;
      if (path.length === 1 && path[0] === "enabled" && l[end] === "=") {
        const v = l.slice(end + 1).replace(/#.*$/, "").trim();
        found = v === "true" ? true : v === "false" ? false : undefined;
      }
    }
  } catch {
    return undefined;
  }
  return found;
}

/**
 * The version a marketplace root offers for `pluginName`: its manifest entry's local source
 * (`"./…"` or `{source: "local", path}`), then the first manifest Codex would read there.
 * Undefined when it cannot be read.
 */
function marketplacePluginVersion(root: string | undefined, pluginName: string): string | undefined {
  if (!root) return undefined;
  for (const rel of MARKETPLACE_MANIFESTS) {
    const mkt = readJson(join(root, rel));
    if (!mkt) continue;
    const entry = (Array.isArray(mkt.plugins) ? mkt.plugins as Array<Record<string, unknown>> : []).find((p) => p && p.name === pluginName);
    if (!entry) return undefined;
    const src = entry.source;
    const path = typeof src === "string" ? src : src && typeof src === "object" && (src as Record<string, unknown>).source === "local" ? (src as Record<string, unknown>).path : undefined;
    if (typeof path !== "string" || !(path === "." || path.startsWith("./"))) return undefined;
    const pluginRoot = resolve(root, path);
    // Codex's manifest order: a root plugin.json carrying the Agent Plugins $schema, then
    // .codex-plugin/, .claude-plugin/, .cursor-plugin/ (codex-rs/utils/plugins plugin_namespace.rs).
    const agent = readJson(join(pluginRoot, "plugin.json"));
    const candidates = [
      ...(agent && typeof agent.$schema === "string" && agent.$schema.startsWith("https://agent-plugins.org/schemas/") ? [agent] : []),
      ...[".codex-plugin", ".claude-plugin", ".cursor-plugin"].map((d) => readJson(join(pluginRoot, d, "plugin.json"))),
    ];
    const manifest = candidates.find((m) => m !== undefined);
    const v = manifest?.version;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  }
  return undefined;
}

interface MarketplaceList { marketplaces?: Array<{ name?: string; root?: string; marketplaceSource?: { sourceType?: string; source?: string } }> }
interface PluginList { installed?: Array<{ pluginId?: string; version?: string; enabled?: boolean; installed?: boolean }> }

/** Register the marketplace + plugin; returns what changed. Throws on a codex failure. */
function installCodexPlugin(src: PluginSource, prior: CodexPluginRecord | undefined, options: Options, notes: string[]): CodexPluginRecord {
  const pluginId = `${src.pluginName}@${src.marketplace}`;
  const record: CodexPluginRecord = { pluginId, marketplace: src.marketplace, source: src.root, version: src.version, addedByInstaller: true };
  if (options.dryRun && !existsSync(options.codexHome)) {
    notes.push(`would add marketplace ${src.marketplace} -> ${homeTilde(src.root)} and install ${pluginId} ${src.version}`);
    return record;
  }

  // 1. The marketplace.
  let mkts = codexJson<MarketplaceList>(["plugin", "marketplace", "list", "--json"], options);
  if (!mkts) {
    // Codex refuses every listing while a configured local marketplace root is gone (a moved
    // checkout). The installer's OWN marketplace in that state is removed so it can be re-added.
    const why = codex(["plugin", "marketplace", "list", "--json"], options).out;
    // Only the installer's own, enabled install is recovered: the configured source in the error
    // must still be the recorded one, and config.toml must show the plugin enabled.
    const reported = new RegExp(`\`${src.marketplace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` at (.+?): `).exec(why)?.[1];
    const gone = !!prior && prior.addedByInstaller !== false && prior.enabled !== false && prior.marketplace === src.marketplace
      && !existsSync(prior.source) && !!reported && resolve(reported) === resolve(prior.source)
      && configPluginEnabled(options, pluginId) === true;
    if (!gone) throw new Error(`codex plugin marketplace list --json gave no answer: ${why.trim().slice(0, 300)}`);
    if (options.dryRun) {
      notes.push(`would remove marketplace ${src.marketplace} (its root ${homeTilde(prior!.source)} is gone) and add it -> ${homeTilde(src.root)}`);
      return record;
    }
    const rm = codex(["plugin", "marketplace", "remove", src.marketplace], options);
    if (rm.error || rm.status !== 0) throw new Error(`codex plugin marketplace remove ${src.marketplace} failed: ${rm.error ?? rm.out.trim().slice(0, 300)}`);
    notes.push(`removed marketplace ${src.marketplace}: its root ${homeTilde(prior!.source)} is gone`);
    mkts = codexJson<MarketplaceList>(["plugin", "marketplace", "list", "--json"], options);
    if (!mkts) throw new Error("codex plugin marketplace list --json gave no answer");
  }
  const existing = (mkts.marketplaces ?? []).find((m) => m.name === src.marketplace);
  const existingSource = existing?.marketplaceSource?.source ?? existing?.root;
  const ours = !!prior && prior.addedByInstaller !== false && !!existingSource && samePath(prior.source, existingSource);
  // The installed list is needed before anything changes: a plugin the user disabled is left
  // exactly as it is — no repoint, no update (`codex plugin add` would re-enable it).
  const before = codexJson<PluginList>(["plugin", "list", "--json"], options);
  if (!before) throw new Error("codex plugin list --json gave no answer");
  const was = (before.installed ?? []).find((p) => p.pluginId === pluginId && p.installed !== false);
  if (was && was.enabled === false && !options.force) {
    const wantedNow = marketplacePluginVersion(existing?.root ?? existingSource, src.pluginName);
    notes.push(`plugin ${pluginId} ${was.version} is disabled — left as you set it (marketplace and plugin untouched)${wantedNow && wantedNow !== was.version ? `; ${wantedNow} is available` : ""}; re-enable it, then re-run`);
    return { ...record, source: existingSource ?? prior?.source ?? src.root, version: was.version ?? src.version, addedByInstaller: ours, enabled: false };
  }
  let marketplace = "";
  let changedSource = false;
  if (existing && existingSource && existing.marketplaceSource?.sourceType === "local" && samePath(existingSource, src.root)) {
    // Same root — but only the marker proves the installer added it (a user may have, by hand).
    record.addedByInstaller = ours;
    marketplace = `marketplace ${src.marketplace} already -> ${homeTilde(src.root)}${ours ? "" : " (added outside wicked-installer)"}`;
  } else if (existing && ((!ours && !options.force) || existing.marketplaceSource?.sourceType !== "local")) {
    // Somebody else's marketplace of the same name: use it, never repoint it silently. A
    // non-local one (a git clone with its ref / sparse paths) is never repointed at all —
    // a remove + add could not put those settings back.
    const local = existing.marketplaceSource?.sourceType === "local";
    record.source = existingSource ?? "";
    record.addedByInstaller = false;
    marketplace = `marketplace ${src.marketplace} is configured from ${homeTilde(existingSource ?? "?")} (${local ? "not by wicked-installer" : `a ${existing.marketplaceSource?.sourceType ?? "non-local"} source`}) — installing from it; ` +
      (local ? `--force repoints it at ${homeTilde(src.root)}` : `to use ${homeTilde(src.root)}, run \`codex plugin marketplace remove ${src.marketplace}\` first`);
  } else {
    if (options.dryRun) {
      changedSource = true; // what the real run would do, so the plugin step plans its re-copy
      marketplace = `would ${existing ? "repoint" : "add"} marketplace ${src.marketplace} -> ${homeTilde(src.root)}`;
    } else {
      if (existing) {
        // Codex refuses to add a marketplace name from a second source, so a repoint is
        // remove + add; a failed add puts the previous source back.
        const rm = codex(["plugin", "marketplace", "remove", src.marketplace], options);
        if (rm.error || rm.status !== 0) throw new Error(`codex plugin marketplace remove ${src.marketplace} failed: ${rm.error ?? rm.out.trim().slice(0, 300)}`);
      }
      const add = codex(["plugin", "marketplace", "add", src.root, "--json"], options);
      if (add.error || add.status !== 0) {
        const restored = existing && existingSource ? codex(["plugin", "marketplace", "add", existingSource, "--json"], options) : undefined;
        throw new Error(`codex plugin marketplace add failed: ${add.error ?? add.out.trim().slice(0, 300)}` +
          (restored ? (restored.status === 0 ? `; restored ${src.marketplace} -> ${homeTilde(existingSource ?? "")}` : `; restoring ${homeTilde(existingSource ?? "")} failed too`) : ""));
      }
      changedSource = true;
      marketplace = `${existing ? "repointed" : "added"} marketplace ${src.marketplace} -> ${homeTilde(src.root)}`;
    }
  }
  notes.push(marketplace);
  /** Undo this run's marketplace change (the marker still holds the previous record). */
  const rollBackMarketplace = (): string => {
    if (options.dryRun) return ""; // a dry run changed nothing, so there is nothing to undo
    const rm = codex(["plugin", "marketplace", "remove", src.marketplace], options);
    if (rm.error || rm.status !== 0) return `; removing the marketplace it just added failed too`;
    if (existing && existingSource) { // only ever a local marketplace (non-local ones are never repointed)
      const back = codex(["plugin", "marketplace", "add", existingSource, "--json"], options);
      return back.status === 0 ? `; marketplace ${src.marketplace} restored to ${homeTilde(existingSource)}` : `; restoring marketplace ${homeTilde(existingSource)} failed`;
    }
    return `; the marketplace it added was removed again`;
  };

  // 2. The plugin.
  const list = codexJson<PluginList>(["plugin", "list", "--json"], options);
  if (!list) throw new Error(`codex plugin list --json gave no answer${changedSource ? rollBackMarketplace() : ""}`);
  const installed = (list.installed ?? []).find((p) => p.pluginId === pluginId && p.installed !== false);
  if (installed && installed.enabled === false && !options.force) {
    notes.push(`plugin ${pluginId} ${installed.version} is disabled — left as you set it; re-enable it, then re-run`);
    return { ...record, version: installed.version ?? src.version, enabled: false };
  }
  const viaForeign = record.source !== src.root;
  // The version wanted is the one the marketplace actually in use offers (a foreign one may be
  // behind or ahead of src). Unknown (a source the installer cannot read) → leave it installed.
  const wanted = viaForeign ? marketplacePluginVersion(existing?.root ?? record.source, src.pluginName) : src.version;
  // A marketplace that now points at a different root must re-copy the plugin even at the same version.
  if (installed && (wanted === undefined || installed.version === wanted) && !changedSource && !options.force) {
    notes.push(`plugin ${pluginId} ${installed.version} already installed${wanted === undefined ? " (its marketplace's version could not be read)" : ""}`);
    record.version = installed.version ?? src.version;
    record.enabled = installed.enabled !== false;
    return record;
  }
  if (options.dryRun) {
    notes.push(`would ${installed ? `update plugin ${pluginId} ${installed.version} ->` : `install plugin ${pluginId}`} ${wanted ?? "(marketplace version)"}`);
    return record;
  }
  const added = codex(["plugin", "add", pluginId, "--json"], options);
  if (added.error || added.status !== 0) {
    throw new Error(`codex plugin add ${pluginId} failed: ${added.error ?? added.out.trim().slice(0, 300)}${changedSource ? rollBackMarketplace() : ""}`);
  }
  let version = src.version;
  try {
    const text = added.stdout ?? added.out;
    version = String((JSON.parse(text.slice(text.indexOf("{"))) as { version?: string }).version ?? version);
  } catch {
    /* keep the manifest version */
  }
  const after = codexJson<PluginList>(["plugin", "list", "--json"], options);
  const landed = (after?.installed ?? []).find((p) => p.pluginId === pluginId && p.installed !== false);
  if (!landed) throw new Error(`codex plugin add ${pluginId} exited 0 but codex plugin list does not show it installed${changedSource ? rollBackMarketplace() : ""}`);
  version = landed.version ?? version;
  record.version = version;
  record.enabled = landed.enabled !== false;
  notes.push(!installed ? `installed plugin ${pluginId} ${version}`
    : installed.version === version ? `re-copied plugin ${pluginId} ${version} from ${homeTilde(record.source)}`
    : `updated plugin ${pluginId} ${installed.version} -> ${version}`);
  return record;
}

/** Every SKILL.md under a plugin's skills dir — nested ones included, as Codex discovers them. */
function countSkillFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) n += countSkillFiles(join(dir, entry.name));
    else if (entry.isFile() && entry.name === "SKILL.md") n += 1;
  }
  return n;
}

/** The installer's own naming of a copied skill: `<product>-*` whose frontmatter name is the dir name. */
function looksInstallerCopied(productId: string, dir: string, name: string): boolean {
  if (!name.startsWith(`${productId}-`)) return false;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false; // the installer only writes plain dirs
  } catch {
    return false;
  }
  try {
    return readSkillName(dir) === name;
  } catch {
    return false; // an unreadable SKILL.md (or a dir named SKILL.md) is never attributed
  }
}

/**
 * Remove loose skills this installer copied into <codexHome>/skills for `productId` that the
 * current install no longer provides (`keep`). Ownership comes from the marker: the recorded
 * `skills` list, or — for a marker written before names were recorded — `<product>-*` dirs whose
 * SKILL.md name is the dir name, but only when that marker lists the product as installed with
 * skills (or --prune-legacy-skills). A symlink, a non-directory, or anything else is left alone.
 * Removed dirs are moved under <codexHome>/wicked-installer/pruned-skills/<stamp>/ (recoverable;
 * Codex does not scan there). Returns the names it could not remove (still owned).
 */
function pruneLooseSkills(productId: string, prior: MarkerProduct | undefined, keep: Set<string>, options: Options, notes: string[]): string[] {
  const skillsDir = join(options.codexHome, "skills");
  if (markerUnreadable || !existsSync(skillsDir)) return [];
  const recorded = prior && Array.isArray(prior.skills) ? prior.skills.filter((n): n is string => typeof n === "string") : undefined;
  // A pre-1.1 marker recorded only a count: the installer's own naming is the attribution.
  const legacyRecorded = !!prior && !recorded && prior.success !== false && (prior.assets?.skills ?? 0) > 0;
  const installerNamed = readdirSync(skillsDir).filter((n) => !keep.has(n) && looksInstallerCopied(productId, join(skillsDir, n), n));
  // A count proves the product was installed, not which directories: naming alone is opt-in.
  const scan = options.pruneLegacySkills ? installerNamed : [];
  const candidates = [...new Set([...(recorded ?? []), ...scan])];
  const unattributed = installerNamed.filter((n) => !candidates.includes(n));
  if (unattributed.length > 0) {
    const why = legacyRecorded
      ? `the marker (written before skill names were recorded) lists ${productId} but not which dirs`
      : "the marker does not record them";
    notes.push(`${unattributed.length} loose ${productId}-* skill dir(s) in ${homeTilde(skillsDir)} look installer-copied, but ${why} — left in place; re-run with --prune-legacy-skills to remove them${options.dryRun ? `: ${unattributed.join(", ")}` : ""}`);
  }
  const basis = options.pruneLegacySkills ? "recorded in the marker or named by the installer (--prune-legacy-skills)" : "recorded in the marker";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(options.codexHome, "wicked-installer", "pruned-skills", stamp);
  const pruned: string[] = [];
  const failed: string[] = [];
  const skippedForeign: string[] = [];
  for (const name of candidates) {
    if (!name || keep.has(name) || name !== basename(name) || name.startsWith(".")) continue;
    const dir = join(skillsDir, name);
    // Only a strict child of <codexHome>/skills is ever moved (an empty or odd name never
    // resolves to the skills dir itself).
    if (resolve(dirname(dir)) !== resolve(skillsDir) || resolve(dir) === resolve(skillsDir)) continue;
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue; // already gone
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      skippedForeign.push(name);
      continue;
    }
    if (options.dryRun) {
      pruned.push(name);
      continue;
    }
    try {
      mkdirSync(backup, { recursive: true });
      renameSync(dir, join(backup, name));
      pruned.push(name);
    } catch (err) {
      failed.push(name);
      notes.push(`could not remove loose skill ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (pruned.length > 0) {
    notes.push(`${options.dryRun ? "would remove" : "removed"} ${pruned.length} loose ${productId} skill(s) from ${homeTilde(skillsDir)} (${basis})${options.dryRun ? `: ${pruned.join(", ")}` : `; moved to ${homeTilde(backup)}`}`);
  }
  if (skippedForeign.length > 0) notes.push(`left ${skippedForeign.length} ${productId}-* skill path(s) that are not plain directories (a symlink is never removed): ${skippedForeign.join(", ")}`);
  return failed;
}

async function installOne(product: Product, options: Options, prior: MarkerProduct | undefined): Promise<InstallReport> {
  const notes: string[] = [];
  let assets: AssetCounts = { skills: 0 };
  let source: PackageSource | undefined;

  try {
    log(options, `Installing ${product.displayName} for Codex...`);

    // Plugin path: a codex with `codex plugin`, and a product that ships a Codex plugin.
    if (product.type !== "mcp-binary" && codexSupportsPlugins(options)) {
      const pluginSrc = resolvePluginSource(product, options, notes);
      if (pluginSrc === "planned") {
        // Preview what the real run would also do (both are read-only under --dry-run).
        pruneLooseSkills(product.id, prior, new Set(), options, notes);
        if (product.id === "wicked-garden") {
          try {
            notes.push(...repairEstateForPlugin(options));
          } catch (err) {
            notes.push(`wicked-estate MCP not checked: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { productId: product.id, displayName: product.displayName, success: true, skipped: false, message: `${product.displayName}: planned (Codex plugin after npm install -g)`, delivery: "planned", pending: [], assets, notes };
      }
      if (pluginSrc) return installAsPlugin(product, pluginSrc, prior, options, notes);
    }

    notes.push(...installProductBinaries(product, options));

    // An mcp-binary product's MCP server is registered by main() after EVERY product of the run
    // is in place: a garden plugin installed later in the same run serves wicked-estate through
    // its launcher, and registering the raw binary first would shadow it.

    source = stageProduct(product, options);
    let copied: string[] = [];
    if (source) {
      copied = copySkills(product, source.root, options);
      assets = { skills: copied.length };
      notes.push(`assets source: ${source.source}`);
      // Loose skills an earlier run copied that this release no longer ships.
      const leftover = pruneLooseSkills(product.id, prior, new Set(copied), options, notes);
      copied = [...copied, ...leftover];
    } else {
      notes.push("no package assets found for Codex");
    }

    const skipped = product.install.type === "manual" || product.install.type === "binary";
    const assetSummary = `skills=${assets.skills}`;
    const delivery: Delivery = options.dryRun ? "planned" : skipped ? "manual" : product.type === "mcp-binary" ? "registered" : assets.skills > 0 ? "copied" : "acquired";
    const pending = runtimePending(product);
    return {
      productId: product.id,
      displayName: product.displayName,
      success: true,
      skipped,
      message: `${product.displayName}: ${skipped ? "manual step noted" : delivery} (${assetSummary})${pending.length > 0 ? " — runtime pending" : ""}`,
      delivery,
      pending,
      assets,
      notes,
      ...(source ? { skills: copied } : {}),
    };
  } catch (err) {
    return {
      productId: product.id,
      displayName: product.displayName,
      success: false,
      skipped: false,
      message: `${product.displayName}: failed: ${err instanceof Error ? err.message : String(err)}`,
      assets,
      notes,
    };
  } finally {
    if (source?.cleanup && !options.dryRun) {
      rmSync(source.cleanup, { recursive: true, force: true });
    }
  }
}

function installAsPlugin(product: Product, src: PluginSource, prior: MarkerProduct | undefined, options: Options, notes: string[]): InstallReport {
  notes.push(`Codex plugin source: ${src.kind === "local" ? "local source" : "global npm package"} ${homeTilde(src.root)}`);
  const record = installCodexPlugin(src, prior?.codexPlugin, options, notes);
  const skills = countSkillFiles(join(src.root, "skills"));
  // Every loose skill the installer copied for this product is now duplicated by the plugin —
  // unless the plugin is disabled: then the loose copies are still what works, and stay owned.
  const leftover = record.enabled !== true && !options.dryRun
    ? (Array.isArray(prior?.skills) ? prior!.skills.filter((n): n is string => typeof n === "string") : [])
    : pruneLooseSkills(product.id, prior, new Set(), options, notes);
  if (product.id === "wicked-garden" && record.enabled === false) {
    notes.push("wicked-estate MCP: not checked — the garden plugin is disabled, so it serves no estate server");
  } else if (product.id === "wicked-garden") {
    // The plugin is registered by now; an estate repair problem is reported, not a failed install
    // (failing here would drop the marker's record of the marketplace just added).
    try {
      notes.push(...repairEstateForPlugin(options));
    } catch (err) {
      notes.push(`wicked-estate MCP repair failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const pending = runtimePending(product);
  const delivery: Delivery = options.dryRun ? "planned" : "registered";
  return {
    productId: product.id,
    displayName: product.displayName,
    success: true,
    skipped: false,
    message: `${product.displayName}: ${delivery} as Codex plugin ${record.pluginId} ${record.version} (skills=${skills})${pending.length > 0 ? " — runtime pending" : ""}`,
    delivery,
    pending,
    assets: { skills },
    notes,
    skills: leftover,
    ...(options.dryRun ? {} : { codexPlugin: record }),
  };
}

// ---------------------------------------------------------------------------
// mcp verb (INTERFACE.md §12.5) — one ad-hoc MCP server, by key. Self-contained copy of the
// verb grammar (§15: no shared modules between install scripts). No env is ever written: the
// CLI host launches the server with the operator's shell environment.
// ---------------------------------------------------------------------------

const MCP_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MCP_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
type McpSub = "upsert" | "remove";
type McpResult = "written" | "converged" | "updated" | "removed" | "skipped" | "unsupported" | "manual" | "failed" | "planned";
interface McpEntry { cli: string; result: McpResult; target: string; detail: string }
interface McpArgs { sub: McpSub; key: string; command?: string; args: string[]; homes: string[]; dryRun: boolean; json: boolean; force: boolean }

class McpUsageError extends Error {}

// Leading `~` only, function replacement (§1.1) so a `$&` in the home path cannot corrupt it.
function mcpExpandHome(value: string): string {
  return value.replace(/^~(?=$|[/\\])/, () => homedir());
}

function parseMcpArgs(argv: string[], homeFlags: string[]): McpArgs {
  const [sub, key, ...rest] = argv;
  if (sub !== "upsert" && sub !== "remove") throw new McpUsageError(`mcp: expected 'upsert' or 'remove', got ${JSON.stringify(sub ?? "")}`);
  if (!key || !MCP_KEY_RE.test(key)) throw new McpUsageError(`mcp ${sub}: key ${JSON.stringify(key ?? "")} must match ^[a-z][a-z0-9-]{0,63}$`);
  const out: McpArgs = { sub, key, args: [], homes: [], dryRun: false, json: false, force: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const valued = name === "--command" || name === "--arg" || homeFlags.includes(name);
    if (valued) {
      let value: string | undefined;
      if (arg !== name) value = arg.slice(name.length + 1);
      else if (i + 1 < rest.length) { i += 1; value = rest[i]; }
      if (value === undefined) throw new McpUsageError(`${name} requires a value`);
      if (name === "--command") out.command = value;
      else if (name === "--arg") out.args.push(value);
      else out.homes.push(resolve(mcpExpandHome(value)));
    } else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--force") out.force = true;
    else throw new McpUsageError(`unknown option: ${arg}`);
  }
  if (sub === "upsert") {
    if (!out.command) throw new McpUsageError("mcp upsert: --command <bin> is required");
    const cmd = mcpExpandHome(out.command);
    if (MCP_CONTROL_CHARS.test(cmd)) throw new McpUsageError("--command: contains control characters");
    if ((cmd.includes("/") || cmd.includes("\\")) && !isAbsolute(cmd)) throw new McpUsageError(`--command: ${JSON.stringify(out.command)} must be a bare command name or an absolute path`);
    out.command = cmd;
  }
  return out;
}

function emitMcp(a: McpArgs, entries: McpEntry[]): void {
  if (a.json) {
    console.log(JSON.stringify({ verb: a.sub, key: a.key, command: a.command ?? null, args: a.args, dryRun: a.dryRun, clis: entries }, null, 2));
    return;
  }
  for (const e of entries) console.log(`[${e.result}] ${e.cli}: ${e.target}${e.detail ? ` — ${e.detail}` : ""}`);
}

/** Parse + help for the verb; a number is the exit code to return without running. */
function mcpArgsOrExit(argv: string[], homeFlags: string[], cli: string): McpArgs | number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log([
      `install-${cli} mcp — register one ad-hoc MCP server`,
      "",
      "Usage:",
      `  install-${cli} mcp upsert <key> --command <bin> [--arg <a>]... [${homeFlags[0]} <dir>] [--force] [--dry-run] [--json]`,
      `  install-${cli} mcp remove <key> [${homeFlags[0]} <dir>] [--dry-run] [--json]`,
      "",
      "No --env: the entry carries no environment; the CLI launches the server with your shell environment.",
    ].join("\n"));
    return 0;
  }
  try {
    return parseMcpArgs(argv, homeFlags);
  } catch (err) {
    if (!(err instanceof McpUsageError)) throw err;
    console.error(`Error: ${err.message}`);
    return 2;
  }
}

// Quote ONE argument for cmd.exe when spawning a .cmd shim with { shell: true } (§1.1 recipe, verbatim).
function mcpWinQuote(arg: string): string {
  if (arg === "") return '""';
  if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; ) {
    let slashes = 0;
    while (i < arg.length && arg[i] === "\\") { slashes += 1; i += 1; }
    if (i === arg.length) { out += "\\".repeat(slashes * 2); break; }
    else if (arg[i] === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; i += 1; }
    else { out += "\\".repeat(slashes) + arg[i]; i += 1; }
  }
  return `${out}"`;
}

/**
 * Spawn the CLI's own `mcp` subcommand (mechanism 2), output captured. On Windows an npm-installed
 * CLI is a `.cmd` shim, which needs the §1.1 recipe (shell + winQuote); cmd.exe expands `%`/`!`
 * even inside quotes, so user data carrying either is refused rather than passed through.
 */
function mcpSpawn(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60000): { status: number | null; out: string; stdout?: string; error?: string } {
  let shim = false;
  let exe = cmd;
  if (process.platform === "win32") {
    // `where` can list an extensionless sh wrapper (npm ships one) before npm.cmd: take the first
    // candidate Windows can launch. An absolute path is its own candidate.
    const lines = isAbsolute(cmd)
      ? [cmd]
      : (spawnSync("where", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const first = lines.find((l) => /\.(exe|com|cmd|bat)$/i.test(l)) ?? "";
    shim = /\.(cmd|bat)$/i.test(first);
    if (/\.(exe|com)$/i.test(first)) exe = first;
    // Run exactly the shim `where` resolved (quoted: it may sit under "Program Files").
    if (shim) exe = mcpWinQuote(first);
    if (shim && [first, ...args].some((a) => /[%!]/.test(a))) {
      return { status: null, out: "", error: `refused: ${cmd} is a .cmd shim and its path or an argument contains % or ! (cmd.exe would expand it); register this server by hand` };
    }
  }
  const res = spawnSync(exe, shim ? args.map(mcpWinQuote) : args, {
    env,
    encoding: "utf8",
    shell: shim,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (res.error) return { status: null, out: "", error: res.error.message };
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}`, stdout: res.stdout ?? "" };
}

function codexMcpHome(a: McpArgs): string {
  if (a.homes.length) return a.homes[a.homes.length - 1];
  return process.env.CODEX_HOME ? resolve(mcpExpandHome(process.env.CODEX_HOME)) : join(homedir(), ".codex");
}

/** Read state through `codex mcp get <key> --json`: absent, present-and-equal, present-and-different. */
function codexMcpRead(a: McpArgs, env: NodeJS.ProcessEnv): { state: "absent" | "matches" | "drifted" } | { state: "error"; detail: string } {
  const r = mcpSpawn("codex", ["mcp", "get", a.key, "--json"], env);
  if (r.error) return { state: "error", detail: r.error };
  if (r.status !== 0) {
    if (/no mcp server named/i.test(r.out)) return { state: "absent" };
    return { state: "error", detail: `codex mcp get ${a.key} exited ${r.status}: ${r.out.trim().slice(0, 300)}` };
  }
  let t: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.out) as { transport?: Record<string, unknown> };
    t = parsed.transport ?? {};
  } catch {
    return { state: "drifted" }; // unparseable but present: re-registering converges it
  }
  const args = Array.isArray(t.args) ? t.args : [];
  const noEnv = (t.env === null || t.env === undefined || (typeof t.env === "object" && Object.keys(t.env as object).length === 0))
    && (!Array.isArray(t.env_vars) || t.env_vars.length === 0);
  const same = t.type === "stdio" && t.command === a.command && JSON.stringify(args) === JSON.stringify(a.args) && noEnv;
  return { state: same ? "matches" : "drifted" };
}

/**
 * Record the action in the v1 codex marker without changing its shape (§10.1): one product entry
 * `mcp-server:<key>` whose notes line names what was registered, dropped again on remove. A later
 * `install-codex` run rewrites the marker from its own reports, so this is bookkeeping, not ownership.
 */
function recordCodexMcp(home: string, a: McpArgs, note: string | undefined): string | undefined {
  const dir = join(home, "wicked-installer");
  const file = join(dir, "codex-install.json");
  const id = `mcp-server:${a.key}`;
  let body: { installedAt?: string; codexHome?: string; products: Array<Record<string, unknown>> } & Record<string, unknown>;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as typeof body;
      if (body.products === undefined) body.products = [];
      if (!Array.isArray(body.products)) throw new Error("products is not an array");
    } catch (err) {
      return `codex marker ${file} unreadable (${err instanceof Error ? err.message : String(err)}); action not recorded`;
    }
  } else {
    if (!note) return undefined;
    body = { installedAt: new Date().toISOString(), codexHome: home, products: [] };
  }
  body.products = body.products.filter((p) => !(p && typeof p === "object" && p.id === id));
  if (note) body.products.push({ id, success: true, skipped: false, assets: { skills: 0 }, notes: [note] });
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.wicked-tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    return `codex marker not written: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

function codexMcpEntry(a: McpArgs): McpEntry {
  const home = codexMcpHome(a);
  const target = join(home, "config.toml");
  const entry = (result: McpResult, detail: string): McpEntry => ({ cli: "codex", result, target, detail });
  if (!commandExists("codex")) return entry("failed", "codex CLI not found on PATH; `codex mcp add` is how Codex registers MCP servers");
  const env = { ...process.env, CODEX_HOME: home };
  // codex refuses a CODEX_HOME that does not exist ("failed to resolve CODEX_HOME"), and a home that
  // does not exist holds no server: absent, without asking (the home is created before an add).
  const st = existsSync(home) ? codexMcpRead(a, env) : { state: "absent" as const };
  if (st.state === "error") return entry("failed", st.detail);
  const addArgs = ["mcp", "add", a.key, "--", a.command ?? "", ...a.args];
  const rendered = `codex ${addArgs.join(" ")}`;
  const withMarker = (e: McpEntry, note: string | undefined): McpEntry => {
    const warn = recordCodexMcp(home, a, note);
    if (warn) e.detail += `; ${warn}`;
    return e;
  };
  if (a.sub === "remove") {
    if (st.state === "absent") return entry("skipped", `absent: no codex MCP server named ${a.key}`);
    if (a.dryRun) return entry("planned", `would run: codex mcp remove ${a.key}`);
    const r = mcpSpawn("codex", ["mcp", "remove", a.key], env);
    if (r.error || r.status !== 0) return entry("failed", `codex mcp remove ${a.key} failed: ${r.error ?? r.out.trim().slice(0, 300)}`);
    return withMarker(entry("removed", `codex mcp remove ${a.key}`), undefined);
  }
  if (st.state === "matches") return entry("converged", "already registered with this command and args");
  if (a.dryRun) return entry("planned", `would be ${st.state === "absent" ? "written" : "updated"}: ${st.state === "drifted" ? `codex mcp remove ${a.key}; ` : ""}${rendered}`);
  mkdirSync(home, { recursive: true });
  if (st.state === "drifted") {
    const rm = mcpSpawn("codex", ["mcp", "remove", a.key], env);
    if (rm.error || rm.status !== 0) return entry("failed", `codex mcp remove ${a.key} (drift repair) failed: ${rm.error ?? rm.out.trim().slice(0, 300)}`);
  }
  const add = mcpSpawn("codex", addArgs, env);
  if (add.error || add.status !== 0) return entry("failed", `${rendered} failed: ${add.error ?? add.out.trim().slice(0, 300)}`);
  const result: McpResult = st.state === "absent" ? "written" : "updated";
  return withMarker(entry(result, rendered), `mcp upsert ${a.key}: ${rendered} (${new Date().toISOString()})`);
}

function runMcp(argv: string[]): number {
  const parsed = mcpArgsOrExit(argv, ["--codex-home"], "codex");
  if (typeof parsed === "number") return parsed;
  let e: McpEntry;
  try {
    e = codexMcpEntry(parsed);
  } catch (err) {
    e = { cli: "codex", result: "failed", target: codexMcpHome(parsed), detail: err instanceof Error ? err.message : String(err) };
  }
  emitMcp(parsed, [e]);
  return e.result === "failed" ? 1 : 0;
}

async function main(): Promise<void> {
  // `mcp` is its own grammar (§12.5), routed before the product parser.
  if (process.argv[2] === "mcp") {
    const code = runMcp(process.argv.slice(3));
    if (code) process.exit(code);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const registry = loadRegistry(options.registryPath);
  const products = resolveProducts(registry, options.productIds, options.all);

  if (!commandExists("codex") && !existsSync(options.codexHome)) {
    log(options, `Codex command/home not detected; creating ${options.codexHome} because Codex was selected.`);
  }

  ensureCodexHome(options);

  const marker = readInstallMarker(options);
  const previous = marker?.products ?? [];
  markerUnreadable = !!marker?.warning;
  const reports: InstallReport[] = [];
  for (const product of products) {
    // An unreadable marker proves no ownership: prune nothing it might have recorded.
    const prior = marker?.warning ? undefined : previous.find((p) => p.id === product.id);
    const report = await installOne(product, options, prior);
    if (marker?.warning) report.notes.push(marker.warning);
    reports.push(report);
  }
  const gardenDisabled = reports.some((r) => r.productId === "wicked-garden" && r.codexPlugin?.enabled === false);
  for (const [i, product] of products.entries()) {
    const report = reports[i];
    if (product.type !== "mcp-binary" || !report.success) continue;
    if (product.id === "wicked-estate" && gardenDisabled) {
      report.notes.push("Codex MCP server wicked-estate: not registered — the garden plugin is disabled, and a direct-binary entry would shadow its launcher once re-enabled; re-enable it and re-run");
      continue;
    }
    try {
      report.notes.push(...registerCodexMcp(product, options));
    } catch (err) {
      report.success = false;
      report.message = `${product.displayName}: failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  writeInstallMarker(options, reports, marker?.warning ? [] : previous);

  if (options.json) {
    console.log(JSON.stringify({ codexHome: options.codexHome, reports }, null, 2));
  } else {
    console.log("");
    for (const report of reports) {
      const status = report.success ? (report.skipped ? "manual" : "ok") : "failed";
      console.log(`[${status}] ${report.message}`);
      for (const note of report.notes) console.log(`  ${note}`);
      for (const item of report.pending ?? []) console.log(`  pending: ${item}`);
    }
  }

  if (reports.some((report) => !report.success)) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
