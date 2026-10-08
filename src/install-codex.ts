#!/usr/bin/env node
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type ProductStatus = "stable" | "active" | "preview" | "design";
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
  assets: AssetCounts;
  notes: string[];
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
  };
}

function printHelp(): void {
  console.log([
    "wicked-installer Codex install piece",
    "",
    "Usage:",
    "  install-codex <product ids...>",
    "  install-codex --products wicked-testing,wicked-brain",
    "  install-codex --all",
    "",
    "Options:",
    "  --codex-home <dir>    Codex home to write into (default: $CODEX_HOME or ~/.codex)",
    "  --registry <file>     Registry JSON path",
    "  --source-root <dir>   Local wicked-* checkout root, used before npm pack",
    "  --skip-binaries      Copy Codex assets without npm/cargo binary installation",
    "  --dry-run            Print what would happen without writing",
    "  --json               Emit machine-readable report",
    "  --force              Reserved for callers that want overwrite semantics",
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
  const requested = all
    ? registry.products.filter((product) => product.status !== "design").map((product) => product.id)
    : ids;

  if (requested.length === 0) {
    throw new Error("no products selected; pass product ids or --all");
  }

  const out: Product[] = [];
  const seen = new Set<string>();

  function add(id: string): void {
    if (seen.has(id)) return;
    const product = byId.get(id);
    if (!product) throw new Error(`unknown product: ${id}`);
    seen.add(id);
    for (const req of product.requires) add(req);
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

// Returns whether the Codex MCP server is absent, already points at the expected
// binary ("matches"), or exists but references a different/stale command ("drifted").
// A name-only check would report a drifted registration as "already registered" and
// never repair it — leaving the machine inconsistent, which is what the installer exists
// to prevent.
function codexMcpServerState(
  serverName: string,
  expectedPath: string,
): "absent" | "matches" | "drifted" {
  if (!commandExists("codex")) return "absent";
  const list = spawnSync("codex", ["mcp", "list"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (list.status !== 0 || !list.stdout) return "absent";
  const exists = list.stdout.split("\n").some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith(`${serverName} `) || trimmed === serverName;
  });
  if (!exists) return "absent";
  // Server is registered — confirm it points at the expected binary. Prefer the
  // detailed `mcp get`; fall back to the list output. If the expected path is
  // absent from both, the registration has drifted and must be repaired.
  const detail = spawnSync("codex", ["mcp", "get", serverName], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const haystack = `${detail.stdout ?? ""}\n${list.stdout}`;
  return haystack.includes(expectedPath) ? "matches" : "drifted";
}

function registerCodexMcp(product: Product, options: Options): string[] {
  const notes: string[] = [];
  if (product.type !== "mcp-binary") return notes;
  if (!commandExists("codex")) {
    throw new Error("codex CLI not found; cannot register MCP server");
  }

  const binaryName = product.install.crate ?? product.install.package ?? product.id;
  const binaryPath = cargoBinaryPath(binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`expected MCP binary not found at ${binaryPath}`);
  }

  if (options.dryRun) {
    notes.push(`would register Codex MCP server ${product.id} -> ${binaryPath}`);
    return notes;
  }

  const state = codexMcpServerState(product.id, binaryPath);
  if (state === "matches") {
    notes.push(`Codex MCP server ${product.id} already registered -> ${binaryPath}`);
    return notes;
  }
  if (state === "drifted") {
    // Registered under a different/stale path — remove before re-adding so the
    // machine ends up consistent (best-effort; `mcp add` may itself overwrite).
    const rm = spawnSync("codex", ["mcp", "remove", product.id], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (rm.status === 0) {
      notes.push(`removed stale Codex MCP server ${product.id} (path drift) before re-registering`);
    }
  }

  run("codex", ["mcp", "add", product.id, "--", binaryPath], options);
  notes.push(`registered Codex MCP server ${product.id} -> ${binaryPath}`);
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

function copySkills(product: Product, root: string, options: Options): number {
  const roots = collectSkillRoots(root);
  let count = 0;

  for (const skillRoot of roots) {
    const skillsDir = codexAssetDirs(root, "skills").find((dir) => skillRoot.startsWith(dir)) ?? join(root, "skills");
    const rel = relative(skillsDir, skillRoot);
    const originalName = readSkillName(skillRoot);
    const nextName = codexSkillName(product.id, originalName ?? "", rel);
    const dest = join(options.codexHome, "skills", sanitizePathPart(nextName));
    copyTree(skillRoot, dest, options);
    rewriteCopiedSkillName(dest, originalName, nextName, options);
    count += 1;
  }

  return count;
}

function copyCodexAssets(product: Product, root: string, options: Options): AssetCounts {
  return {
    skills: copySkills(product, root, options),
  };
}

function writeInstallMarker(options: Options, reports: InstallReport[]): void {
  const markerDir = join(options.codexHome, "wicked-installer");
  const markerPath = join(markerDir, "codex-install.json");
  const body = {
    installedAt: new Date().toISOString(),
    codexHome: options.codexHome,
    products: reports.map((report) => ({
      id: report.productId,
      success: report.success,
      skipped: report.skipped,
      assets: report.assets,
      notes: report.notes,
    })),
  };

  if (options.dryRun) {
    log(options, `  dry-run: write ${markerPath}`);
    return;
  }
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(body, null, 2)}\n`);
}

async function installOne(product: Product, options: Options): Promise<InstallReport> {
  const notes: string[] = [];
  let assets: AssetCounts = { skills: 0 };
  let source: PackageSource | undefined;

  try {
    log(options, `Installing ${product.displayName} for Codex...`);
    notes.push(...installProductBinaries(product, options));

    // Register (or repair) the MCP server with the Codex CLI after its binary is
    // installed — an mcp-binary product is only usable in Codex once registered.
    if (product.type === "mcp-binary") {
      notes.push(...registerCodexMcp(product, options));
    }

    source = stageProduct(product, options);
    if (source) {
      assets = copyCodexAssets(product, source.root, options);
      notes.push(`assets source: ${source.source}`);
    } else {
      notes.push("no package assets found for Codex");
    }

    const skipped = product.install.type === "manual" || product.install.type === "binary";
    const assetSummary = `skills=${assets.skills}`;
    return {
      productId: product.id,
      displayName: product.displayName,
      success: true,
      skipped,
      message: `${product.displayName}: ${skipped ? "manual step noted" : "installed"} (${assetSummary})`,
      assets,
      notes,
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
function mcpSpawn(cmd: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; out: string; error?: string } {
  let shim = false;
  let exe = cmd;
  if (process.platform === "win32") {
    const where = spawnSync("where", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = (where.stdout ?? "").split(/\r?\n/).find(Boolean)?.trim() ?? "";
    shim = /\.(cmd|bat)$/i.test(first);
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
    timeout: 60000,
  });
  if (res.error) return { status: null, out: "", error: res.error.message };
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
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

  const reports: InstallReport[] = [];
  for (const product of products) {
    reports.push(await installOne(product, options));
  }
  writeInstallMarker(options, reports);

  if (options.json) {
    console.log(JSON.stringify({ codexHome: options.codexHome, reports }, null, 2));
  } else {
    console.log("");
    for (const report of reports) {
      const status = report.success ? (report.skipped ? "manual" : "ok") : "failed";
      console.log(`[${status}] ${report.message}`);
      for (const note of report.notes) console.log(`  ${note}`);
    }
  }

  if (reports.some((report) => !report.success)) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
