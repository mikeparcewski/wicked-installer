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
import { basename, dirname, join, relative, resolve } from "node:path";
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
  opencodeHome: string;
  registryPath: string;
  sourceRoot: string;
  dryRun: boolean;
  json: boolean;
  force: boolean;
  skipBinaries: boolean;
}

interface AssetCounts {
  skills: number;
  hooks: number;
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

// Quote ONE argument for cmd.exe when spawning an npm/npx .cmd shim with { shell: true }
// (INTERFACE.md §1.1 — required for new scripts; codex omits it as a documented v1 caveat).
// Implements the CommandLineToArgvW backslash/quote rule (MSVCRT); the surrounding double
// quotes then neutralize every cmd metacharacter that is literal inside quotes.
function winQuote(arg: string): string {
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

function stripAnsi(value: string): string {
  // OpenCode's `mcp list` colorizes output; strip SGR escapes before parsing.
  return value.replace(/\[[0-9;]*m/g, "");
}

function existingDirs(paths: string[]): string[] {
  return [...new Set(paths.filter((dir) => existsSync(dir)))];
}

function opencodeAssetDirs(root: string, leaf: string): string[] {
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
  // Function replacement so a `$&` in the home path cannot corrupt it (INTERFACE.md §1.1).
  return path.replace(/^~(?=$|[/\\])/, () => homedir());
}

function parseArgs(argv: string[]): Options {
  const productIds: string[] = [];
  let all = false;
  let opencodeHome = process.env.OPENCODE_CONFIG
    ? expandHome(process.env.OPENCODE_CONFIG)
    : join(homedir(), ".config", "opencode");
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
    } else if (arg === "--opencode-home" && argv[i + 1]) {
      i += 1;
      opencodeHome = expandHome(argv[i]);
    } else if (arg.startsWith("--opencode-home=")) {
      opencodeHome = expandHome(arg.slice("--opencode-home=".length));
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
    opencodeHome: resolve(opencodeHome),
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
    "wicked-installer OpenCode install piece",
    "",
    "Usage:",
    "  install-opencode <product ids...>",
    "  install-opencode --products wicked-testing,wicked-brain",
    "  install-opencode --all",
    "",
    "Options:",
    "  --opencode-home <dir>  OpenCode config root to write into (default: $OPENCODE_CONFIG or ~/.config/opencode)",
    "  --registry <file>      Registry JSON path",
    "  --source-root <dir>    Local wicked-* checkout root, used before npm pack",
    "  --skip-binaries        Copy OpenCode assets without npm/cargo binary installation",
    "  --dry-run              Print what would happen without writing",
    "  --json                 Emit machine-readable report",
    "  --force                Reserved for callers that want overwrite semantics",
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

function run(
  cmd: string,
  args: string[],
  options: Options,
  cwd?: string,
  capture = false,
  env?: NodeJS.ProcessEnv,
): string {
  const rendered = [cmd, ...args].join(" ");
  if (options.dryRun) {
    log(options, `  dry-run: ${rendered}${cwd ? `  (cwd: ${cwd})` : ""}`);
    return "";
  }
  // Windows npm/npx are .cmd shims: Node ≥ 20.12 refuses to auto-resolve a .cmd
  // without { shell: true }, and shell mode needs each arg pre-quoted (INTERFACE.md §1.1).
  // Real executables (git, cargo, node, tar, opencode) spawn unquoted, no shell.
  const useShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const result = spawnSync(cmd, useShell ? args.map(winQuote) : args, {
    cwd,
    env,
    encoding: "utf8",
    shell: useShell,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stderr || result.stdout || ""}`.trim() : "";
    throw new Error(`${rendered} failed${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function ensureOpencodeHome(options: Options): void {
  const dirs = [
    options.opencodeHome,
    join(options.opencodeHome, "skills"),
  ];
  if (options.dryRun) {
    for (const dir of dirs) log(options, `  dry-run: mkdir -p ${dir}`);
    return;
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  accessSync(options.opencodeHome, fsConstants.W_OK);
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
      notes.push(`OpenCode assets installed directly; not running ${install.package} ${install.command ?? "install"} because package installers may target other CLIs`);
      break;
    }
    case "cargo": {
      const crate = install.crate ?? install.package;
      if (!crate) throw new Error(`${product.id}: install.crate required`);
      if (!commandExists("cargo")) {
        throw new Error("cargo not found; install Rust from https://rustup.rs and retry");
      }
      const args = ["install", crate];
      if (install.version) args.push("--version", install.version);
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
      notes.push("git plugin assets copied directly for OpenCode");
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
  const tmp = mkdtempSync(join(tmpdir(), `wicked-opencode-${product.id}-`));

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

// OpenCode resolves its global config to $XDG_CONFIG_HOME/opencode (falling back to
// ~/.config/opencode); OPENCODE_CONFIG only points the CLI at a config FILE to *read*
// and does not steer where `opencode mcp add` *writes*. To make MCP registration land
// in options.opencodeHome we set XDG_CONFIG_HOME to its parent — which only maps cleanly
// when the home's basename is literally "opencode" (the standard layout). For a
// non-standard home we cannot direct the CLI and skip registration with a note.
function opencodeConfigEnv(options: Options): NodeJS.ProcessEnv | undefined {
  if (basename(options.opencodeHome) !== "opencode") return undefined;
  return { ...process.env, XDG_CONFIG_HOME: dirname(options.opencodeHome) };
}

// Returns whether the OpenCode MCP server is absent, already points at the expected
// binary ("matches"), or exists but references a different/stale command ("drifted").
// A name-only check would report a drifted registration as "already registered" and
// never repair it, leaving the machine inconsistent.
function opencodeMcpServerState(
  serverName: string,
  expectedPath: string,
  env: NodeJS.ProcessEnv,
): "absent" | "matches" | "drifted" {
  if (!commandExists("opencode")) return "absent";
  const list = spawnSync("opencode", ["mcp", "list"], {
    env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 15000,
  });
  if (list.status !== 0 || !list.stdout) return "absent";
  const clean = stripAnsi(list.stdout);
  // `mcp list` renders one line per server ("●  ✗ <name> failed ...") with the launch
  // command on an indented follow-up line; tokenize to find the server name exactly.
  const exists = clean.split("\n").some((line) => line.split(/\s+/).includes(serverName));
  if (!exists) return "absent";
  // Server is registered — confirm it points at the expected binary (shown inline in the
  // list output). If the expected path is absent, the registration has drifted.
  return clean.includes(expectedPath) ? "matches" : "drifted";
}

function registerOpencodeMcp(product: Product, options: Options): string[] {
  const notes: string[] = [];
  if (product.type !== "mcp-binary") return notes;
  if (!commandExists("opencode")) {
    throw new Error("opencode CLI not found; cannot register MCP server");
  }

  const binaryName = product.install.crate ?? product.install.package ?? product.id;
  const binaryPath = cargoBinaryPath(binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`expected MCP binary not found at ${binaryPath}`);
  }

  const env = opencodeConfigEnv(options);
  if (!env) {
    notes.push(
      `skipped OpenCode MCP registration: config root ${options.opencodeHome} is non-standard ` +
      `(basename must be "opencode" to direct 'opencode mcp add'); register manually with: ` +
      `opencode mcp add ${product.id} -- ${binaryPath}`,
    );
    return notes;
  }

  if (options.dryRun) {
    notes.push(`would register OpenCode MCP server ${product.id} -> ${binaryPath}`);
    return notes;
  }

  const state = opencodeMcpServerState(product.id, binaryPath, env);
  if (state === "matches") {
    notes.push(`OpenCode MCP server ${product.id} already registered -> ${binaryPath}`);
    return notes;
  }

  // OpenCode has no `mcp remove` subcommand; `opencode mcp add` is read-modify-write and
  // overwrites an existing server of the same name, so re-adding both registers a new
  // server and repairs a drifted one.
  run("opencode", ["mcp", "add", product.id, "--", binaryPath], options, undefined, false, env);
  notes.push(
    state === "drifted"
      ? `repaired drifted OpenCode MCP server ${product.id} -> ${binaryPath}`
      : `registered OpenCode MCP server ${product.id} -> ${binaryPath}`,
  );
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
      opencodeAssetDirs(candidate, "skills").length > 0
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
    const tmp = mkdtempSync(join(tmpdir(), `wicked-opencode-${product.id}-`));
    const dest = join(tmp, "repo");
    run("git", ["clone", "--depth", "1", product.install.repo, dest], options);
    return { root: dest, cleanup: tmp, source: "git" };
  }

  const packageName = product.install.package;
  if (!packageName || options.dryRun) return undefined;

  const tmp = mkdtempSync(join(tmpdir(), `wicked-opencode-${product.id}-`));
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

function opencodeSkillName(productId: string, name: string, rel: string): string {
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
  for (const skillsDir of opencodeAssetDirs(root, "skills")) {
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
    const skillsDir = opencodeAssetDirs(root, "skills").find((dir) => skillRoot.startsWith(dir)) ?? join(root, "skills");
    const rel = relative(skillsDir, skillRoot);
    const originalName = readSkillName(skillRoot);
    const nextName = opencodeSkillName(product.id, originalName ?? "", rel);
    const dest = join(options.opencodeHome, "skills", sanitizePathPart(nextName));
    copyTree(skillRoot, dest, options);
    rewriteCopiedSkillName(dest, originalName, nextName, options);
    count += 1;
  }

  return count;
}

// OpenCode has NO JSON hook format — its only lifecycle-hook mechanism is a TypeScript
// plugin. A product opts in by shipping hooks/opencode-plugin.ts; the plugin resolves its
// sibling scripts from "<pluginBasename>-hooks" next to itself at runtime.
function opencodePluginSource(root: string): string | undefined {
  for (const dir of [join(root, "hooks"), join(root, ".claude", "hooks")]) {
    const file = join(dir, "opencode-plugin.ts");
    if (existsSync(file)) return file;
  }
  return undefined;
}

function installOpencodePlugin(product: Product, root: string, options: Options): { installed: number; notes: string[] } {
  const notes: string[] = [];
  const pluginSrc = opencodePluginSource(root);
  if (!pluginSrc) {
    notes.push("no OpenCode plugin (hooks/opencode-plugin.ts) in package; skills-only install");
    return { installed: 0, notes };
  }

  const pluginsDir = join(options.opencodeHome, "plugins");
  const pluginDest = join(pluginsDir, `${product.id}.ts`);
  const hooksDest = join(pluginsDir, `${product.id}-hooks`);
  const srcHooksDir = dirname(pluginSrc);

  if (options.dryRun) {
    log(options, `  dry-run: copy ${pluginSrc} -> ${pluginDest}`);
    log(options, `  dry-run: copy hook scripts from ${srcHooksDir} -> ${hooksDest} (excluding opencode-plugin.ts)`);
    notes.push(`would install OpenCode plugin ${product.id}.ts + ${product.id}-hooks/`);
    return { installed: 1, notes };
  }

  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(pluginDest, readFileSync(pluginSrc, "utf8"));

  // The plugin file itself lands at plugins/<id>.ts; every OTHER entry that sits beside it
  // in the source hooks dir is a runtime hook script the plugin references from <id>-hooks/.
  mkdirSync(hooksDest, { recursive: true });
  for (const entry of readdirSync(srcHooksDir, { withFileTypes: true })) {
    if (entry.name === "opencode-plugin.ts") continue;
    const from = join(srcHooksDir, entry.name);
    if (!shouldCopy(from)) continue;
    cpSync(from, join(hooksDest, entry.name), { recursive: true, force: true, filter: shouldCopy });
  }
  notes.push(`installed OpenCode plugin ${product.id}.ts + ${product.id}-hooks/`);
  return { installed: 1, notes };
}

function copyOpencodeAssets(product: Product, root: string, options: Options): { assets: AssetCounts; notes: string[] } {
  const skills = copySkills(product, root, options);
  const plugin = installOpencodePlugin(product, root, options);
  return {
    assets: { skills, hooks: plugin.installed },
    notes: plugin.notes,
  };
}

// Strip JSONC line/block comments while leaving comment-like sequences INSIDE strings
// intact (e.g. the "https://..." schema URL). A character-level scanner that tracks
// string state is used rather than a regex so the ":" before "//" never needs guarding.
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next; i += 1; }      // escape: copy escaped char verbatim
      else if (ch === quote) { inString = false; }
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i += 1; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i += 1; continue; }
    out += ch;
  }
  return out;
}

// Atomic JSON write: serialize to a sibling temp file, then rename over the target so a
// crash mid-write can never leave the user's config truncated (INTERFACE.md §8.2 spirit).
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.wicked-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

// Register <opencodeHome>/skills in the config's `skills.paths` so OpenCode actually
// loads the skills we copied there. OpenCode does NOT auto-scan <configRoot>/skills — it
// only loads skills from (a) config-declared `skills.paths` and (b) an external scan under
// ~/.claude and ~/.agents (verified against the opencode 1.17.x binary; config shape is
// "skills": { "paths": [...], "urls": [...] }). Without this the copied skills are inert.
// Idempotent, dry-run-aware, and parse-failure-safe (never corrupts an unreadable config).
function registerSkillsPath(options: Options): string[] {
  const notes: string[] = [];
  const skillsDir = join(options.opencodeHome, "skills");

  // Prefer an existing config file (the real one is .jsonc); seed .jsonc if neither exists.
  const jsoncPath = join(options.opencodeHome, "opencode.jsonc");
  const jsonPath = join(options.opencodeHome, "opencode.json");
  const target = existsSync(jsoncPath) ? jsoncPath : existsSync(jsonPath) ? jsonPath : jsoncPath;
  const label = basename(target);

  if (options.dryRun) {
    notes.push(`would register ${skillsDir} in ${label} skills.paths`);
    return notes;
  }

  let cfg: Record<string, unknown>;
  if (existsSync(target)) {
    let raw: string;
    try {
      raw = readFileSync(target, "utf8");
    } catch (err) {
      notes.push(`could not read ${label} (${err instanceof Error ? err.message : String(err)}); register ${skillsDir} in skills.paths manually`);
      return notes;
    }
    try {
      const parsed = JSON.parse(stripJsonc(raw)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("config root is not a JSON object");
      }
      cfg = parsed as Record<string, unknown>;
    } catch (err) {
      // Do NOT rewrite a config we cannot parse — leave it byte-for-byte and tell the user.
      notes.push(`${label} is not parseable (${err instanceof Error ? err.message : String(err)}); left untouched — register ${skillsDir} in skills.paths manually`);
      return notes;
    }
  } else {
    cfg = { $schema: "https://opencode.ai/config.json" };
  }

  const skills = (typeof cfg.skills === "object" && cfg.skills !== null && !Array.isArray(cfg.skills))
    ? (cfg.skills as Record<string, unknown>)
    : {};
  const paths = Array.isArray(skills.paths) ? (skills.paths as unknown[]).slice() : [];
  const already = paths.some((p) => typeof p === "string" && resolve(expandHome(p)) === resolve(skillsDir));
  if (already) {
    notes.push(`skills.paths already registers ${skillsDir}`);
    return notes;
  }

  paths.push(skillsDir);
  skills.paths = paths;
  cfg.skills = skills;

  try {
    writeJsonAtomic(target, cfg);
  } catch (err) {
    notes.push(`failed to write ${label} (${err instanceof Error ? err.message : String(err)}); register ${skillsDir} in skills.paths manually`);
    return notes;
  }
  notes.push(`registered ${skillsDir} in ${label} skills.paths`);
  return notes;
}

function writeInstallMarker(options: Options, reports: InstallReport[]): void {
  const markerDir = join(options.opencodeHome, "wicked-installer");
  const markerPath = join(markerDir, "opencode-install.json");
  const body = {
    installedAt: new Date().toISOString(),
    opencodeHome: options.opencodeHome,
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
  let assets: AssetCounts = { skills: 0, hooks: 0 };
  let source: PackageSource | undefined;

  try {
    log(options, `Installing ${product.displayName} for OpenCode...`);
    notes.push(...installProductBinaries(product, options));

    // Register (or repair) the MCP server with the OpenCode CLI after its binary is
    // installed — an mcp-binary product is only usable in OpenCode once registered.
    if (product.type === "mcp-binary") {
      notes.push(...registerOpencodeMcp(product, options));
    }

    source = stageProduct(product, options);
    if (source) {
      const result = copyOpencodeAssets(product, source.root, options);
      assets = result.assets;
      notes.push(...result.notes);
      // OpenCode won't load <home>/skills unless it's declared in the config's
      // skills.paths, so register it after any skills actually land.
      if (assets.skills > 0) {
        notes.push(...registerSkillsPath(options));
      }
      notes.push(`assets source: ${source.source}`);
    } else {
      notes.push("no package assets found for OpenCode");
    }

    const skipped = product.install.type === "manual" || product.install.type === "binary";
    const assetSummary = `skills=${assets.skills} hooks=${assets.hooks}`;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const registry = loadRegistry(options.registryPath);
  const products = resolveProducts(registry, options.productIds, options.all);

  if (!commandExists("opencode") && !existsSync(options.opencodeHome)) {
    log(options, `OpenCode command/home not detected; creating ${options.opencodeHome} because OpenCode was selected.`);
  }

  ensureOpencodeHome(options);

  const reports: InstallReport[] = [];
  for (const product of products) {
    reports.push(await installOne(product, options));
  }
  writeInstallMarker(options, reports);

  if (options.json) {
    console.log(JSON.stringify({ opencodeHome: options.opencodeHome, reports }, null, 2));
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
