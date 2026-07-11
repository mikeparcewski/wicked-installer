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
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// This is the reference implementation of the wicked-installer per-CLI install
// script interface (contract v1 + v1.1 extensions). It is modeled directly on
// src/install-codex.ts (the normative v1 reference) and keeps the same skeleton,
// helper names, and flag surface so the family stays recognizable. Claude-specific
// behavior: multi config-dir fan-out, mcpServers wiring into .claude.json, hooks
// scaffolding, verbs (install|status|uninstall), and install marker v2.
//
// Self-contained by design: no imports from other src/ modules, node: builtins only.
// Cross-platform: path.join everywhere, where/which gated on platform, .cmd spawn
// rule for npm/npx, atomic tmp+rename with Windows retry, no unix-only shell tricks.
// ---------------------------------------------------------------------------

type ProductStatus = "stable" | "active" | "preview" | "design";
type ProductType = "npm-cli" | "npm-lib" | "mcp-binary" | "claude-plugin" | "desktop-binary";
type InstallType = "npm-global" | "npm-run" | "binary" | "manual" | "github-binary" | "git-plugin" | "cargo";

type Verb = "install" | "status" | "uninstall";
const VERBS = new Set<Verb>(["install", "status", "uninstall"]);

interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
  // v1.1: optional MCP block. Unknown-field tolerant — absent on most products.
  mcp?: Record<string, McpServerSpec>;
  note?: string;
}

interface Registry {
  version: string;
  products: Product[];
}

interface Options {
  verb: Verb;
  productIds: string[];
  all: boolean;
  // Every --claude-home occurrence (resolved + tilde-expanded). Empty ⇒ fall to env/probe.
  homeFlags: string[];
  registryPath: string;
  sourceRoot: string;
  dryRun: boolean;
  json: boolean;
  force: boolean;
  skipBinaries: boolean;
  purgeBinaries: boolean;
}

interface AssetCounts {
  skills: number;
  agents: number;
  commands: number;
  mcp: number;
  hooks: number;
}

type ActionKind =
  | "copy-skill"
  | "write-json-key"
  | "merge-hook"
  | "acquire"
  | "migrate-removed"
  | "collision-skipped"
  | "restore-prior"
  | "remove";

type ActionResult = "ok" | "planned" | "skipped" | "failed";

interface Action {
  kind: ActionKind;
  target: string;
  result: ActionResult;
  detail?: string;
}

interface InstallReport {
  productId: string;
  displayName: string;
  success: boolean;
  skipped: boolean;
  message: string;
  version?: string;
  heuristic?: boolean;
  assets: AssetCounts;
  actions: Action[];
  notes: string[];
}

interface PackageSource {
  root: string;
  cleanup?: string;
  source: "local" | "npm-pack" | "git";
}

// -------- Install marker v2 --------

type MarkerFileRecord =
  | { kind: "dir" | "file"; path: string }
  | { kind: "json-key"; file: string; pointer: string; wroteHash: string; prior?: unknown }
  | { kind: "hooks-entry"; file: string; event: string; ownerMatch: { commandContains: string } };

interface MarkerProduct {
  version?: string;
  installedAt: string;
  source?: "local" | "npm-pack" | "git";
  lastResult: "installed" | "partial" | "failed";
  assets?: Record<string, number>;
  files: MarkerFileRecord[];
  notes: string[];
}

interface MarkerV2 {
  markerVersion: 2;
  cli: "claude";
  configDir: string;
  installerVersion?: string;
  updatedAt: string;
  products: Record<string, MarkerProduct>;
}

interface LegacyMarker {
  installedAt?: string;
  claudeHome?: string;
  products?: Array<{ id: string; success?: boolean; skipped?: boolean; assets?: unknown; notes?: string[] }>;
}

interface MarkerRaw {
  v2?: MarkerV2;
  legacy?: LegacyMarker;
  corrupt: boolean;
}

interface Target {
  dir: string;
  mcpFile: string;
  origin: "flag" | "env" | "probe" | "fallback";
}

interface Resolution {
  targets: Target[];
  primary: string;
  cliPresent: boolean;
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
// Claude config-dir identity markers (ANY-of). See §11.1 / §11.2.
const IDENTITY_MARKERS = ["settings.json", "plugins", "projects"];

// ---------------------------------------------------------------------------
// Paths & platform helpers
// ---------------------------------------------------------------------------

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

// Leading ~ only, followed by /, \, or end-of-string. Function replacement so a $
// in the home path cannot be interpreted as a replacement token (spec §1.1).
function expandHome(value: string): string {
  return value.replace(/^~(?=$|[/\\])/, () => homedir());
}

// Split on runs of separators (`+`) so JSON.stringify's escaped Windows backslashes
// (`\\`, two chars) collapse to a single `/` instead of an empty segment -> `//`.
// Without `+`, containsOwner's forward-slash owner key fails to match the `//`-laden
// stringified hook payload on Windows (idempotency + uninstall break). Collapsing runs
// is also correct/idempotent for the real-path callers (toMarkerPath, marker compares).
function normalizeSlash(value: string): string {
  return value.split(/[\\/]+/).join("/");
}

// Synchronous sleep without spawning a shell (Windows rename backoff).
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function installerVersion(): string | undefined {
  try {
    const p = join(__dirname, "..", "package.json");
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
  } catch {
    /* ignore */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Options {
  // --help/-h routed before verb defaulting (§3.2).
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let verb: Verb = "install";
  let rest = argv;
  const first = argv[0];
  if (first && VERBS.has(first as Verb)) {
    verb = first as Verb;
    rest = argv.slice(1);
  }

  const productIds: string[] = [];
  const homeFlags: string[] = [];
  let all = false;
  let registryPath = defaultRegistryPath();
  let sourceRoot = process.env.WICKED_SOURCE_ROOT
    ? expandHome(process.env.WICKED_SOURCE_ROOT)
    : findDefaultSourceRoot();
  let dryRun = false;
  let json = false;
  let force = false;
  let skipBinaries = false;
  let purgeBinaries = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
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
    } else if (arg === "--purge-binaries") {
      purgeBinaries = true;
    } else if (arg === "--claude-home" && rest[i + 1]) {
      i += 1;
      homeFlags.push(resolve(expandHome(rest[i])));
    } else if (arg.startsWith("--claude-home=")) {
      homeFlags.push(resolve(expandHome(arg.slice("--claude-home=".length))));
    } else if (arg === "--registry" && rest[i + 1]) {
      i += 1;
      registryPath = expandHome(rest[i]);
    } else if (arg.startsWith("--registry=")) {
      registryPath = expandHome(arg.slice("--registry=".length));
    } else if (arg === "--source-root" && rest[i + 1]) {
      i += 1;
      sourceRoot = expandHome(rest[i]);
    } else if (arg.startsWith("--source-root=")) {
      sourceRoot = expandHome(arg.slice("--source-root=".length));
    } else if (arg === "--products" && rest[i + 1]) {
      i += 1;
      productIds.push(...rest[i].split(",").map((id) => id.trim()).filter(Boolean));
    } else if (arg.startsWith("--products=")) {
      productIds.push(...arg.slice("--products=".length).split(",").map((id) => id.trim()).filter(Boolean));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      productIds.push(arg);
    }
  }

  return {
    verb,
    productIds,
    all,
    homeFlags,
    registryPath: resolve(registryPath),
    sourceRoot: resolve(sourceRoot),
    dryRun,
    json,
    force,
    skipBinaries,
    purgeBinaries,
  };
}

function printHelp(): void {
  console.log([
    "wicked-installer Claude Code install piece",
    "",
    "Usage:",
    "  install-claude [verb] <product ids...>",
    "  install-claude --products wicked-testing,wicked-brain",
    "  install-claude --all",
    "  install-claude status --all",
    "  install-claude uninstall wicked-testing",
    "",
    "Verbs (default: install):",
    "  install    Acquire + wire assets into every resolved config dir",
    "  status     Read-only: report installed products from install markers",
    "  uninstall  Remove exactly what install created (marker-driven)",
    "",
    "Options:",
    "  --claude-home <dir>   Config dir to write into (repeatable; default: $CLAUDE_CONFIG_DIR or ~/.claude)",
    "  --registry <file>     Registry JSON path",
    "  --source-root <dir>   Local wicked-* checkout root, used before npm pack",
    "  --skip-binaries       Copy Claude assets without npm/cargo binary installation",
    "  --purge-binaries      uninstall only: also remove npm/cargo globals",
    "  --dry-run             Print what would happen without writing",
    "  --json                Emit machine-readable report",
    "  --force               Overwrite/take-ownership semantics (see contract §8)",
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

// ---------------------------------------------------------------------------
// Child processes (Windows .cmd rule + --json stdout purity)
// ---------------------------------------------------------------------------

function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0;
}

// Quote ONE argument for cmd.exe when spawning an npm/npx .cmd shim with { shell: true }.
// Implements the CommandLineToArgvW backslash/quote rule (MSVCRT), then relies on the
// surrounding double quotes to neutralize every cmd metacharacter that is literal inside
// quotes: space & | < > ( ) ^ and " itself. Caveat: cmd expands %VAR% (always) and !VAR!
// (only with delayed expansion, which Node does not enable) even inside quotes and there is
// no command-line escape for them — so % is NOT in the bare set and % / !-bearing data must
// never be routed through a .cmd (installer args are package names, semver, and a tmpdir()
// path, none of which contain % or !). See INTERFACE.md §1.1. This is the conforming
// reference the spec points at.
function winQuote(arg: string): string {
  if (arg === "") return '""';
  // Bare pass-through only for a conservatively safe, metacharacter-free set (no %).
  if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; ) {
    let slashes = 0;
    while (i < arg.length && arg[i] === "\\") {
      slashes += 1;
      i += 1;
    }
    if (i === arg.length) {
      // Backslashes immediately before the closing quote are doubled.
      out += "\\".repeat(slashes * 2);
      break;
    } else if (arg[i] === '"') {
      // Backslashes before an embedded quote are doubled, then the quote is escaped.
      out += "\\".repeat(slashes * 2 + 1) + '"';
      i += 1;
    } else {
      out += "\\".repeat(slashes) + arg[i];
      i += 1;
    }
  }
  return `${out}"`;
}

function run(cmd: string, args: string[], options: Options, cwd?: string, capture = false): string {
  const rendered = [cmd, ...args].join(" ");
  if (options.dryRun) {
    log(options, `  dry-run: ${rendered}${cwd ? `  (cwd: ${cwd})` : ""}`);
    return "";
  }
  // npm/npx are .cmd shims on Windows; Node >= 20.12 no longer auto-resolves them.
  const useShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const spawnArgs = useShell ? args.map(winQuote) : args;
  // Capture (rather than inherit) whenever --json so child output never pollutes the report.
  const cap = capture || options.json;
  const result = spawnSync(cmd, spawnArgs, {
    cwd,
    encoding: "utf8",
    shell: useShell,
    stdio: cap ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = cap ? `${result.stderr || result.stdout || ""}`.trim() : "";
    throw new Error(`${rendered} failed${detail ? `: ${detail}` : ""}`);
  }
  return capture ? (result.stdout ?? "") : "";
}

// ---------------------------------------------------------------------------
// Config-dir resolution (§11.1)
// ---------------------------------------------------------------------------

function markerDirFor(dir: string): string {
  return join(dir, "wicked-installer");
}

function markerPathFor(dir: string): string {
  return join(markerDirFor(dir), "claude-install.json");
}

function hasIdentity(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return IDENTITY_MARKERS.some((m) => existsSync(join(dir, m)));
}

function dirIsPresent(dir: string): boolean {
  return hasIdentity(dir) || existsSync(markerPathFor(dir));
}

// Split CLAUDE_CONFIG_DIR on path.delimiter + ',' — ';'+',' on Windows so a bare
// ':' can never shatter a C:\ path; ':'+',' elsewhere.
function splitConfigDirValue(value: string): string[] {
  const parts = value.split(process.platform === "win32" ? /[;,]/ : /[:,]/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// The default ~/.claude home keeps its state file at ~/.claude.json (in homedir);
// any override dir gets <dir>/.claude.json (Claude Code relocates state there).
function mcpFileFor(dir: string): string {
  const defaultHome = resolve(homedir(), ".claude");
  return dir === defaultHome ? join(homedir(), ".claude.json") : join(dir, ".claude.json");
}

function makeTarget(dir: string, origin: Target["origin"]): Target {
  const resolved = resolve(dir);
  return { dir: resolved, mcpFile: mcpFileFor(resolved), origin };
}

function resolveTargets(options: Options): Resolution {
  // 1. Explicit flags win as the full set (trusted; created if absent).
  if (options.homeFlags.length > 0) {
    const targets = options.homeFlags.map((d) => makeTarget(d, "flag"));
    return { targets, primary: targets[0].dir, cliPresent: true };
  }

  // 2. CLAUDE_CONFIG_DIR is authoritative and exclusive when set.
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) {
    const dirs = splitConfigDirValue(env).map((d) => resolve(expandHome(d)));
    if (dirs.length > 0) {
      const targets = dirs.map((d) => makeTarget(d, "env"));
      return { targets, primary: targets[0].dir, cliPresent: true };
    }
  }

  // 3. Probe the default home, identity-filtered. Only ~/.claude is a config root Claude
  //    Code actually reads (its state file ~/.claude.json sits alongside it); no other
  //    default dir is read, so probing others would fan out into dirs whose assets never
  //    load. The exclusive alternative is CLAUDE_CONFIG_DIR (step 2) or --claude-home (step 1).
  const probes = [resolve(homedir(), ".claude")];
  const passing = probes.filter(dirIsPresent);
  if (passing.length > 0) {
    const targets = passing.map((d) => makeTarget(d, "probe"));
    return { targets, primary: targets[0].dir, cliPresent: true };
  }

  // 4. Nothing present: install creates ~/.claude; status/uninstall exit 2.
  const fallback = resolve(homedir(), ".claude");
  return { targets: [makeTarget(fallback, "fallback")], primary: fallback, cliPresent: false };
}

function ensureConfigDir(dir: string, options: Options): void {
  const dirs = [dir, join(dir, "skills")];
  if (options.dryRun) {
    for (const d of dirs) log(options, `  dry-run: mkdir -p ${d}`);
    return;
  }
  for (const d of dirs) mkdirSync(d, { recursive: true });
  accessSync(dir, fsConstants.W_OK);
}

// ---------------------------------------------------------------------------
// Marker path <-> absolute path translation
// ---------------------------------------------------------------------------

function toMarkerPath(configDir: string, absPath: string): string {
  const rel = relative(configDir, absPath);
  if (rel && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    return normalizeSlash(rel);
  }
  const home = homedir();
  let p = absPath;
  if (p === home || p.startsWith(home + sep)) {
    p = `~${p.slice(home.length)}`;
  }
  return normalizeSlash(p);
}

function fromMarkerPath(configDir: string, markerPath: string): string {
  let p = markerPath;
  if (p.startsWith("~/") || p === "~" || p.startsWith("~\\")) p = expandHome(p);
  p = p.split("/").join(sep);
  if (isAbsolute(p)) return resolve(p);
  return resolve(configDir, p);
}

// ---------------------------------------------------------------------------
// Atomic JSON writes + backups
// ---------------------------------------------------------------------------

function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EBUSY")) {
        sleepSync(100);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function atomicWriteJson(filePath: string, data: unknown, options: Options): void {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (options.dryRun) {
    log(options, `  dry-run: write ${filePath}`);
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `${basename(filePath)}.wicked-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, text);
  renameWithRetry(tmp, filePath);
}

const backedUpThisRun = new Set<string>();

function pruneBackups(backupsDir: string, base: string): void {
  try {
    const matches = readdirSync(backupsDir)
      .filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"))
      .sort();
    while (matches.length > 5) {
      const oldest = matches.shift();
      if (oldest) rmSync(join(backupsDir, oldest), { force: true });
    }
  } catch {
    /* best-effort */
  }
}

function backupConfigFile(configDir: string, filePath: string, options: Options): void {
  if (options.dryRun) return;
  if (!existsSync(filePath)) return;
  if (backedUpThisRun.has(filePath)) return;
  backedUpThisRun.add(filePath);
  const backupsDir = join(configDir, "wicked-installer", "backups");
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = basename(filePath);
  cpSync(filePath, join(backupsDir, `${base}.${stamp}.bak`), { force: true });
  pruneBackups(backupsDir, base);
}

// ---------------------------------------------------------------------------
// JSON pointer + canonical hashing
// ---------------------------------------------------------------------------

function encodePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointerTokens(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getByPointer(root: unknown, pointer: string): unknown {
  let cur: unknown = root;
  for (const tok of pointerTokens(pointer)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[tok];
  }
  return cur;
}

function deleteByPointer(root: unknown, pointer: string): void {
  const toks = pointerTokens(pointer);
  let cur: unknown = root;
  for (let i = 0; i < toks.length - 1; i += 1) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[toks[i]];
  }
  if (cur && typeof cur === "object") delete (cur as Record<string, unknown>)[toks[toks.length - 1]];
}

function setByPointer(root: unknown, pointer: string, value: unknown): void {
  const toks = pointerTokens(pointer);
  let cur: unknown = root;
  for (let i = 0; i < toks.length - 1; i += 1) {
    const o = cur as Record<string, unknown>;
    if (o[toks[i]] === null || typeof o[toks[i]] !== "object") o[toks[i]] = {};
    cur = o[toks[i]];
  }
  (cur as Record<string, unknown>)[toks[toks.length - 1]] = value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function containsOwner(value: unknown, ownerKey: string): boolean {
  try {
    return normalizeSlash(JSON.stringify(value) ?? "").includes(ownerKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Acquisition (§5) — identical dispatch to codex, with acquire actions recorded
// ---------------------------------------------------------------------------

function installProductBinaries(product: Product, options: Options, actions: Action[]): string[] {
  const install = product.install;
  const notes: string[] = [];

  if (options.skipBinaries) {
    notes.push("binary/package installation skipped by --skip-binaries");
    actions.push({ kind: "acquire", target: product.id, result: "skipped", detail: "--skip-binaries" });
    return notes;
  }

  switch (install.type) {
    case "npm-global": {
      if (!install.package) throw new Error(`${product.id}: install.package required`);
      run("npm", ["install", "-g", install.package], options);
      actions.push({ kind: "acquire", target: install.package, result: options.dryRun ? "planned" : "ok", detail: "npm -g" });
      break;
    }
    case "npm-run": {
      if (!install.package) throw new Error(`${product.id}: install.package required`);
      notes.push(`Claude assets installed directly; not running ${install.package} ${install.command ?? "install"} because package installers may target other CLIs`);
      actions.push({ kind: "acquire", target: install.package, result: "skipped", detail: "npm-run: assets staged directly" });
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
      actions.push({ kind: "acquire", target: crate, result: options.dryRun ? "planned" : "ok", detail: "cargo install" });
      break;
    }
    case "github-binary": {
      installGithubBinary(product, options);
      actions.push({ kind: "acquire", target: product.id, result: options.dryRun ? "planned" : "ok", detail: "github-binary" });
      break;
    }
    case "manual":
    case "binary": {
      notes.push(install.instructions ?? `${product.displayName} requires manual installation`);
      break;
    }
    case "git-plugin": {
      notes.push("git plugin assets copied directly for Claude");
      break;
    }
    default: {
      const neverInstall: never = install.type;
      throw new Error(`unsupported install type: ${neverInstall as string}`);
    }
  }

  if (install.mcpInstructions) notes.push(install.mcpInstructions);
  return notes;
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

  const isWin = process.platform === "win32";
  const binDir = isWin
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "wicked", "bin")
    : join(homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, isWin ? `${product.id}.exe` : product.id);
  const tmp = mkdtempSync(join(tmpdir(), `wicked-claude-${product.id}-`));

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
    if (!isWin) {
      // chmod on unix only; Windows relies on the .exe suffix (no chmod).
      chmodSync(dest, 0o755);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// Staging (§6)
// ---------------------------------------------------------------------------

function productPackageName(product: Product): string | undefined {
  return product.install.package ?? product.install.crate ?? product.id;
}

function localProductRoot(product: Product, options: Options): string | undefined {
  const candidates = [
    join(options.sourceRoot, product.id),
    join(options.sourceRoot, productPackageName(product) ?? product.id),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json")) || existsSync(join(candidate, "skills"))) {
      return candidate;
    }
  }
  return undefined;
}

function wouldUseNpmPack(product: Product, options: Options): boolean {
  return !localProductRoot(product, options)
    && product.install.type !== "git-plugin"
    && !!product.install.package;
}

function stageProduct(product: Product, options: Options): PackageSource | undefined {
  const local = localProductRoot(product, options);
  if (local) return { root: local, source: "local" };

  if (product.install.type === "git-plugin" && product.install.repo) {
    const tmp = mkdtempSync(join(tmpdir(), `wicked-claude-${product.id}-`));
    const dest = join(tmp, "repo");
    run("git", ["clone", "--depth", "1", product.install.repo, dest], options);
    return { root: dest, cleanup: tmp, source: "git" };
  }

  const packageName = product.install.package;
  if (!packageName || options.dryRun) return undefined;

  const tmp = mkdtempSync(join(tmpdir(), `wicked-claude-${product.id}-`));
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

function readStagedVersion(root: string): string | undefined {
  const p = join(root, "package.json");
  if (!existsSync(p)) return undefined;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Copy helpers (§6/§7)
// ---------------------------------------------------------------------------

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
  cpSync(src, dest, { recursive: true, force: true, filter: shouldCopy });
}

function readSkillName(skillDir: string): string | undefined {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return undefined;
  const body = readFileSync(skillFile, "utf8");
  return body.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
}

function claudeSkillName(productId: string, name: string, rel: string): string {
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
  const updated = body.replace(/^name:\s*["']?([^"'\n]+)["']?\s*$/m, `name: ${nextName}`);
  writeFileSync(skillFile, updated);
}

// Prefer platform/<cli>/ content over the generic skill body when present (§7.1).
// A skill ships skills/<skill>/platform/claude/ with files that REPLACE the generic
// equivalents; when absent, the generic content is used as-is.
function skillCopyRoot(skillRoot: string): string {
  const override = join(skillRoot, "platform", "claude");
  if (existsSync(join(override, "SKILL.md"))) return override;
  return skillRoot;
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

// ---------------------------------------------------------------------------
// Skill install with ownership / collision / replace-on-install (§8.5/§8.6)
// ---------------------------------------------------------------------------

function skillDirOwner(markerPathRel: string, marker: MarkerV2, selfId: string): string | undefined {
  const norm = normalizeSlash(markerPathRel);
  for (const [pid, entry] of Object.entries(marker.products)) {
    if (pid === selfId) continue;
    for (const f of entry.files) {
      if ((f.kind === "dir" || f.kind === "file") && normalizeSlash(f.path) === norm) return pid;
    }
  }
  return undefined;
}

// Two-signal signature: frontmatter name references the product AND the body
// mentions the product id. A third-party dir squatting the name never matches.
function skillSignatureMatches(dest: string, productId: string): boolean {
  const name = readSkillName(dest);
  if (!name) return false;
  const skillFile = join(dest, "SKILL.md");
  if (!existsSync(skillFile)) return false;
  const body = readFileSync(skillFile, "utf8");
  const nameOwns = name.startsWith(productId) || name.startsWith("wicked-");
  return nameOwns && body.includes(productId);
}

function pruneOwnerFile(marker: MarkerV2, ownerId: string, markerPathRel: string): void {
  const owner = marker.products[ownerId];
  if (!owner) return;
  const norm = normalizeSlash(markerPathRel);
  owner.files = owner.files.filter(
    (f) => !((f.kind === "dir" || f.kind === "file") && normalizeSlash(f.path) === norm),
  );
}

function installSkills(
  product: Product,
  root: string,
  target: Target,
  options: Options,
  actions: Action[],
  marker: MarkerV2,
  mp: MarkerProduct,
): number {
  const skillsDir = join(root, "skills");
  const roots = findSkillRoots(skillsDir);
  let count = 0;

  for (const skillRoot of roots) {
    const rel = relative(skillsDir, skillRoot);
    const originalName = readSkillName(skillRoot);
    const nextName = claudeSkillName(product.id, originalName ?? "", rel);
    const destName = sanitizePathPart(nextName);
    const dest = join(target.dir, "skills", destName);
    const markerPathRel = toMarkerPath(target.dir, dest);
    const copyFrom = skillCopyRoot(skillRoot);

    if (existsSync(dest) && !options.dryRun) {
      const owner = skillDirOwner(markerPathRel, marker, product.id);
      if (owner && owner !== product.id) {
        if (options.force) {
          pruneOwnerFile(marker, owner, markerPathRel);
          rmSync(dest, { recursive: true, force: true });
          actions.push({ kind: "collision-skipped", target: markerPathRel, result: "ok", detail: `ownership transferred from ${owner}` });
        } else {
          actions.push({ kind: "collision-skipped", target: markerPathRel, result: "skipped", detail: `owned by ${owner}` });
          continue;
        }
      } else if (!owner && !skillSignatureMatches(dest, product.id)) {
        // Genuinely foreign dir: never overwrite, even with --force.
        actions.push({
          kind: "collision-skipped",
          target: markerPathRel,
          result: options.force ? "failed" : "skipped",
          detail: "foreign skill dir present; rename it and re-run",
        });
        continue;
      } else {
        // Ours (marker or signature): replace-on-install so upstream-deleted files don't linger.
        rmSync(dest, { recursive: true, force: true });
      }
    }

    copyTree(copyFrom, dest, options);
    rewriteCopiedSkillName(dest, originalName, nextName, options);
    mp.files.push({ kind: "dir", path: markerPathRel });
    actions.push({ kind: "copy-skill", target: markerPathRel, result: options.dryRun ? "planned" : "ok" });
    count += 1;
  }

  // Compat shim: wicked-testing version stamp read by downstream wg-check consumers.
  if (product.id === "wicked-testing") {
    const stampAbs = join(target.dir, "skills", ".wicked-testing-version");
    const ver = readStagedVersion(root) ?? "";
    if (options.dryRun) {
      log(options, `  dry-run: write ${stampAbs}`);
    } else {
      mkdirSync(dirname(stampAbs), { recursive: true });
      writeFileSync(stampAbs, `${ver}\n`);
    }
    mp.files.push({ kind: "file", path: toMarkerPath(target.dir, stampAbs) });
    actions.push({ kind: "copy-skill", target: toMarkerPath(target.dir, stampAbs), result: options.dryRun ? "planned" : "ok", detail: "version stamp" });
  }

  return count;
}

// ---------------------------------------------------------------------------
// MCP wiring (§8.3) — read-modify-write into <target>/.claude.json mcpServers
// ---------------------------------------------------------------------------

function expandMcpSpec(spec: McpServerSpec): { command: string; args: string[]; env?: Record<string, string> } {
  const out: { command: string; args: string[]; env?: Record<string, string> } = {
    command: expandHome(spec.command),
    args: spec.args ? spec.args.slice() : [],
  };
  if (spec.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env)) env[k] = expandHome(v);
    out.env = env;
  }
  return out;
}

function wireMcp(
  product: Product,
  target: Target,
  options: Options,
  actions: Action[],
  notes: string[],
  mp: MarkerProduct,
  prev: MarkerProduct | undefined,
): number {
  const block = product.mcp;
  if (!block || Object.keys(block).length === 0) return 0;

  const file = target.mcpFile;
  const fileMarker = toMarkerPath(target.dir, file);
  let obj: Record<string, unknown> = {};

  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      actions.push({ kind: "write-json-key", target: fileMarker, result: "failed", detail: `unreadable ${file}` });
      notes.push(`mcp wiring skipped: cannot read ${file}`);
      return 0;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Never clobber a corrupt config with {} — fail the action, leave file byte-identical.
      actions.push({ kind: "write-json-key", target: fileMarker, result: "failed", detail: `corrupt JSON; fix or remove ${file} and re-run` });
      notes.push(`mcp wiring skipped: corrupt ${file}`);
      return 0;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      actions.push({ kind: "write-json-key", target: fileMarker, result: "failed", detail: `unexpected JSON shape in ${file}` });
      return 0;
    }
    obj = parsed as Record<string, unknown>;
  }

  const rawServers = obj.mcpServers;
  const serverMap: Record<string, unknown> =
    rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)
      ? (rawServers as Record<string, unknown>)
      : {};

  const prevHashes = new Map<string, string>();
  if (prev) {
    for (const f of prev.files) {
      if (f.kind === "json-key" && f.file === fileMarker) prevHashes.set(f.pointer, f.wroteHash);
    }
  }

  let changed = false;
  let count = 0;

  for (const name of Object.keys(block)) {
    const desired = expandMcpSpec(block[name]);
    const pointer = `/mcpServers/${encodePointerToken(name)}`;
    const actionTarget = `${fileMarker}${pointer}`;
    const existing = serverMap[name];
    const desiredHash = hashValue(desired);
    let priorForMarker: unknown = null;

    if (existing === undefined) {
      serverMap[name] = desired;
      changed = true;
      actions.push({ kind: "write-json-key", target: actionTarget, result: options.dryRun ? "planned" : "ok", detail: "added" });
    } else if (deepEqual(existing, desired)) {
      actions.push({ kind: "write-json-key", target: actionTarget, result: options.dryRun ? "planned" : "skipped", detail: "already current" });
    } else if (prevHashes.get(pointer) === hashValue(existing)) {
      serverMap[name] = desired;
      changed = true;
      actions.push({ kind: "write-json-key", target: actionTarget, result: options.dryRun ? "planned" : "ok", detail: "updated" });
    } else {
      // Present and foreign.
      if (options.force) {
        priorForMarker = existing;
        serverMap[name] = desired;
        changed = true;
        actions.push({ kind: "write-json-key", target: actionTarget, result: options.dryRun ? "planned" : "ok", detail: "overwrote foreign (--force)" });
      } else {
        actions.push({ kind: "write-json-key", target: actionTarget, result: "skipped", detail: "foreign value; use --force to overwrite" });
        continue;
      }
    }

    mp.files.push({ kind: "json-key", file: fileMarker, pointer, wroteHash: desiredHash, prior: priorForMarker });
    count += 1;

    // PATH-resolution warning for bare command names (§4.1).
    const cmd = desired.command;
    if (!cmd.includes("/") && !cmd.includes("\\") && !commandExists(cmd)) {
      const hint = process.platform === "win32" ? "%USERPROFILE%\\.cargo\\bin" : "~/.cargo/bin";
      notes.push(`mcp server '${name}' command '${cmd}' not found on PATH (check ${hint})`);
    }
  }

  if (changed) {
    obj.mcpServers = serverMap;
    backupConfigFile(target.dir, file, options);
    atomicWriteJson(file, obj, options);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Hooks wiring (§8.4) — structured handler; inert until a product ships hooks/
// ---------------------------------------------------------------------------

function rewritePluginRoot(value: unknown, rootAbs: string): unknown {
  if (typeof value === "string") return value.split("${CLAUDE_PLUGIN_ROOT}").join(rootAbs);
  if (Array.isArray(value)) return value.map((v) => rewritePluginRoot(v, rootAbs));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = rewritePluginRoot(v, rootAbs);
    return o;
  }
  return value;
}

function wireHooks(
  product: Product,
  root: string,
  target: Target,
  options: Options,
  actions: Action[],
  notes: string[],
  mp: MarkerProduct,
): number {
  const hooksJson = join(root, "hooks", "hooks.json");
  if (!existsSync(hooksJson)) return 0;

  // 1. Copy the product payload to an owned root (replace-on-install).
  const payloadRoot = join(target.dir, "wicked-installer", "products", product.id);
  if (!options.dryRun) {
    rmSync(payloadRoot, { recursive: true, force: true });
    mkdirSync(payloadRoot, { recursive: true });
  } else {
    log(options, `  dry-run: refresh payload ${payloadRoot}`);
  }
  for (const sibling of ["hooks", "lib", "scenarios", "schemas", "scripts", "bin"]) {
    const src = join(root, sibling);
    if (existsSync(src)) copyTree(src, join(payloadRoot, sibling), options);
  }
  mp.files.push({ kind: "dir", path: toMarkerPath(target.dir, payloadRoot) });
  actions.push({ kind: "merge-hook", target: toMarkerPath(target.dir, payloadRoot), result: options.dryRun ? "planned" : "ok", detail: "payload copied" });

  // 2. Parse hooks.json.
  let hooksDef: Record<string, unknown>;
  try {
    hooksDef = JSON.parse(readFileSync(hooksJson, "utf8")) as Record<string, unknown>;
  } catch {
    notes.push(`hooks.json parse failed for ${product.id}`);
    return 0;
  }
  const eventsRaw = hooksDef.hooks && typeof hooksDef.hooks === "object" ? hooksDef.hooks : hooksDef;
  const events = eventsRaw as Record<string, unknown>;

  // 3. Merge into <target>/settings.json event arrays.
  const settingsFile = join(target.dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    } catch {
      actions.push({ kind: "merge-hook", target: toMarkerPath(target.dir, settingsFile), result: "failed", detail: "corrupt settings.json; fix or remove and re-run" });
      return 0;
    }
  }
  const settingsHooks: Record<string, unknown> =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};

  const ownerKey = `wicked-installer/products/${product.id}`;
  let count = 0;

  for (const [event, groupsRaw] of Object.entries(events)) {
    if (!Array.isArray(groupsRaw)) continue;
    const rewritten = groupsRaw.map((g) => rewritePluginRoot(g, payloadRoot));
    const existingArr = Array.isArray(settingsHooks[event]) ? (settingsHooks[event] as unknown[]) : [];
    // Remove all owned entries for this product, then insert the current desired set.
    const kept = existingArr.filter((g) => !containsOwner(g, ownerKey));
    settingsHooks[event] = [...kept, ...rewritten];
    mp.files.push({ kind: "hooks-entry", file: toMarkerPath(target.dir, settingsFile), event, ownerMatch: { commandContains: ownerKey } });
    actions.push({ kind: "merge-hook", target: `${toMarkerPath(target.dir, settingsFile)}#${event}`, result: options.dryRun ? "planned" : "ok" });
    count += 1;
  }

  if (count > 0) {
    settings.hooks = settingsHooks;
    backupConfigFile(target.dir, settingsFile, options);
    atomicWriteJson(settingsFile, settings, options);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Stale-artifact purge (§8.1 marker-driven stale-sweep + §12.4 legacy sweeps) —
// remove this product's own historical orphans only, never touching shared JSON
// config or a file the product did not create.
// ---------------------------------------------------------------------------

/**
 * Purge stale on-disk artifacts a PRIOR install of this product left behind that are
 * no longer part of its footprint — specifically the pre-skills-only `agents/` and
 * `commands/` trees. Garden and testing are skills-only now (this script never copies
 * agents/commands, §7.2), but older installs seeded `<configDir>/agents/<productId>*.md`
 * and `<configDir>/commands/<productId>/`, which must be cleaned on upgrade.
 *
 * Two ownership-scoped passes — a file this product did not create is never removed:
 *  1. Marker-driven (§8.1): every `agents/`|`commands/` dir/file the PRIOR marker entry
 *     recorded that the current run did not re-create (diffed against the freshly
 *     journaled `mp.files`) is deleted — precise removal of exactly what was listed.
 *  2. Naming-heuristic (§12.4): pre-marker installs have no file list, so match this
 *     product's own naming only — `agents/<productId>*.md`, the `commands/<productId>/`
 *     dir, and `commands/<productId>:*` variants. A shared prefix boundary check keeps a
 *     foreign file (e.g. wicked-business vs wicked-bus) from ever matching.
 *
 * Called after the skills copy + MCP/hooks wiring so pass 1 can diff against the
 * complete current footprint. `--dry-run` reports each removal as a planned
 * `migrate-removed` action and writes nothing. Purged paths are recorded in both the
 * report actions and the marker entry's `notes[]`.
 */
function purgeStaleArtifacts(
  product: Product,
  target: Target,
  options: Options,
  actions: Action[],
  mp: MarkerProduct,
  prev: MarkerProduct | undefined,
): void {
  const done = new Set<string>();

  const purge = (abs: string, markerPath: string, detail: string): void => {
    const key = normalizeSlash(markerPath);
    if (done.has(key)) return;
    if (isSharedDiscoveryDir(target.dir, abs)) return; // never delete a shared discovery dir itself
    if (!existsSync(abs)) return;
    done.add(key);
    if (options.dryRun) {
      log(options, `  dry-run: purge ${abs}`);
      actions.push({ kind: "migrate-removed", target: markerPath, result: "planned", detail });
    } else {
      rmSync(abs, { recursive: true, force: true });
      actions.push({ kind: "migrate-removed", target: markerPath, result: "ok", detail });
    }
    mp.notes.push(`purged stale ${detail}: ${markerPath}`);
  };

  const isLegacyArtifact = (rel: string): boolean => rel.startsWith("agents/") || rel.startsWith("commands/");

  // True when `name` is one of THIS product's own artifacts: the exact product id or the
  // id followed by a namespace separator. The boundary stops a foreign file that merely
  // shares a prefix (wicked-business vs wicked-bus) from ever matching.
  const ownedName = (name: string): boolean =>
    name === product.id || (name.startsWith(product.id) && /^[-:._]/.test(name.slice(product.id.length)));

  // 1. Marker-driven: prior agents/commands paths this run did not re-create.
  const current = new Set<string>();
  for (const f of mp.files) {
    if (f.kind === "dir" || f.kind === "file") current.add(normalizeSlash(f.path));
  }
  for (const f of prev?.files ?? []) {
    if (f.kind !== "dir" && f.kind !== "file") continue;
    const rel = normalizeSlash(f.path);
    if (!isLegacyArtifact(rel) || current.has(rel)) continue;
    purge(fromMarkerPath(target.dir, f.path), f.path, "agents/commands artifact (marker)");
  }

  // 2. Naming-heuristic (pre-marker migration): this product's own agents/ + commands/.
  const agentsDir = join(target.dir, "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && ownedName(entry.name)) {
        const abs = join(agentsDir, entry.name);
        purge(abs, toMarkerPath(target.dir, abs), "agent (heuristic)");
      }
    }
  }
  const commandsDir = join(target.dir, "commands");
  if (existsSync(commandsDir)) {
    for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
      if (ownedName(entry.name)) {
        const abs = join(commandsDir, entry.name);
        purge(abs, toMarkerPath(target.dir, abs), "command (heuristic)");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Install marker read / init / flush
// ---------------------------------------------------------------------------

function isMarkerV2(value: unknown): value is MarkerV2 {
  return !!value && typeof value === "object" && (value as { markerVersion?: unknown }).markerVersion === 2;
}

function readMarkerRaw(dir: string): MarkerRaw {
  const p = markerPathFor(dir);
  if (!existsSync(p)) return { corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { corrupt: true };
  }
  if (isMarkerV2(parsed)) return { v2: parsed, corrupt: false };
  return { legacy: parsed as LegacyMarker, corrupt: false };
}

function loadOrInitMarker(dir: string): MarkerV2 {
  const raw = readMarkerRaw(dir);
  if (raw.v2) return raw.v2;
  // Fresh v2 (a pre-existing v1/legacy marker is replaced; its on-disk assets are
  // reconciled forward as products get re-installed).
  return {
    markerVersion: 2,
    cli: "claude",
    configDir: dir,
    installerVersion: installerVersion(),
    updatedAt: new Date().toISOString(),
    products: {},
  };
}

function flushMarkerV2(dir: string, marker: MarkerV2, options: Options): void {
  atomicWriteJson(markerPathFor(dir), marker, options);
}

// ---------------------------------------------------------------------------
// install verb
// ---------------------------------------------------------------------------

function installOneInstall(
  product: Product,
  options: Options,
  targets: Target[],
  markers: Map<string, MarkerV2>,
): InstallReport {
  const notes: string[] = [];
  const actions: Action[] = [];
  let assets: AssetCounts = { skills: 0, agents: 0, commands: 0, mcp: 0, hooks: 0 };
  let source: PackageSource | undefined;
  let version: string | undefined;
  const skipped = product.install.type === "manual" || product.install.type === "binary";

  try {
    log(options, `Installing ${product.displayName} for Claude...`);
    notes.push(...installProductBinaries(product, options, actions));

    source = stageProduct(product, options);
    version = source ? readStagedVersion(source.root) : undefined;

    let lastSkills = 0;
    let lastMcp = 0;
    let lastHooks = 0;

    for (const target of targets) {
      const marker = markers.get(target.dir);
      if (!marker) continue;
      const prev = marker.products[product.id];
      const mp: MarkerProduct = {
        version,
        installedAt: new Date().toISOString(),
        source: source ? source.source : undefined,
        lastResult: "partial",
        assets: { skills: 0, agents: 0, commands: 0, mcp: 0, hooks: 0 },
        files: [],
        notes: [],
      };
      // Journal: set the (partial) entry immediately so a crash keeps a footprint.
      marker.products[product.id] = mp;

      let skillCount = 0;
      let hookCount = 0;
      if (source) {
        skillCount = installSkills(product, source.root, target, options, actions, marker, mp);
      }
      const mcpCount = wireMcp(product, target, options, actions, notes, mp, prev);
      if (source) {
        hookCount = wireHooks(product, source.root, target, options, actions, notes, mp);
        // Purge pre-skills-only agents/commands this product left in prior installs, now
        // that the current (skills-only) footprint is fully journaled in mp.files.
        purgeStaleArtifacts(product, target, options, actions, mp, prev);
      }

      mp.assets = { skills: skillCount, agents: 0, commands: 0, mcp: mcpCount, hooks: hookCount };
      mp.lastResult = "installed";
      lastSkills = skillCount;
      lastMcp = mcpCount;
      lastHooks = hookCount;
    }

    assets = { skills: lastSkills, agents: 0, commands: 0, mcp: lastMcp, hooks: lastHooks };

    if (source) {
      notes.push(`assets source: ${source.source}`);
    } else if (options.dryRun && wouldUseNpmPack(product, options)) {
      notes.push("asset counts unavailable (dry-run, npm-pack source)");
    } else {
      notes.push("no package assets found for Claude");
    }
    if (targets.length > 1) notes.push(`fanned out to ${targets.length} config dirs`);

    const assetSummary = `skills=${assets.skills}, mcp=${assets.mcp}, hooks=${assets.hooks}`;
    return {
      productId: product.id,
      displayName: product.displayName,
      success: true,
      skipped,
      message: `${product.displayName}: ${skipped ? "manual step noted" : "installed"} (${assetSummary})`,
      version,
      assets,
      actions,
      notes,
    };
  } catch (err) {
    return {
      productId: product.id,
      displayName: product.displayName,
      success: false,
      skipped: false,
      message: `${product.displayName}: failed: ${err instanceof Error ? err.message : String(err)}`,
      version,
      assets,
      actions,
      notes,
    };
  } finally {
    if (source?.cleanup && !options.dryRun) {
      rmSync(source.cleanup, { recursive: true, force: true });
    }
  }
}

function runInstall(options: Options, registry: Registry): number {
  const products = resolveProducts(registry, options.productIds, options.all);
  const resolution = resolveTargets(options);

  if (!resolution.cliPresent && resolution.targets[0].origin === "fallback") {
    log(options, `Claude command/home not detected; creating ${resolution.primary} because Claude was selected.`);
  }

  for (const target of resolution.targets) ensureConfigDir(target.dir, options);

  const markers = new Map<string, MarkerV2>();
  for (const target of resolution.targets) markers.set(target.dir, loadOrInitMarker(target.dir));

  const reports: InstallReport[] = [];
  for (const product of products) {
    reports.push(installOneInstall(product, options, resolution.targets, markers));
    // Incremental flush after each product: a crash loses at most the in-flight one.
    for (const target of resolution.targets) {
      const marker = markers.get(target.dir);
      if (!marker) continue;
      marker.updatedAt = new Date().toISOString();
      flushMarkerV2(target.dir, marker, options);
    }
  }

  emitReport(options, "install", resolution, reports);
  return reports.some((report) => !report.success) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// status verb (read-only)
// ---------------------------------------------------------------------------

function runStatus(options: Options, registry: Registry): number {
  const resolution = resolveTargets(options);
  if (!resolution.cliPresent) {
    if (!options.json) console.log("Claude not detected (no config dir or install marker present).");
    emitReport(options, "status", resolution, []);
    return 2;
  }

  const byId = new Map(registry.products.map((p) => [p.id, p]));
  const markerByTarget = new Map<string, MarkerRaw>();
  for (const target of resolution.targets) markerByTarget.set(target.dir, readMarkerRaw(target.dir));

  const idsPresent = new Set<string>();
  for (const target of resolution.targets) {
    const m = markerByTarget.get(target.dir);
    if (!m) continue;
    if (m.v2) Object.keys(m.v2.products).forEach((id) => idsPresent.add(id));
    else if (m.legacy?.products) m.legacy.products.forEach((p) => idsPresent.add(p.id));
  }

  let selected: string[];
  if (options.all) selected = [...idsPresent];
  else if (options.productIds.length) selected = options.productIds;
  else selected = [...idsPresent];

  let hadParseError = false;
  const reports: InstallReport[] = [];

  for (const id of selected) {
    const notes: string[] = [];
    let anyPresent = false;

    for (const target of resolution.targets) {
      const m = markerByTarget.get(target.dir);
      if (!m) continue;
      if (m.corrupt) {
        notes.push(`${target.dir}: corrupt marker`);
        hadParseError = true;
        continue;
      }
      if (m.legacy && !m.v2) {
        const has = m.legacy.products?.some((p) => p.id === id);
        if (has) {
          anyPresent = true;
          notes.push(`${target.dir}: legacy-marker (exact uninstall unavailable — re-run install to upgrade bookkeeping)`);
        } else {
          notes.push(`${target.dir}: missing`);
        }
        continue;
      }
      const entry = m.v2?.products[id];
      if (!entry) {
        notes.push(`${target.dir}: missing`);
        continue;
      }
      anyPresent = true;

      const missing = entry.files.filter(
        (f) => (f.kind === "dir" || f.kind === "file") && !existsSync(fromMarkerPath(target.dir, f.path)),
      );
      let modifiedExternally = false;
      for (const f of entry.files) {
        if (f.kind !== "json-key") continue;
        const abs = fromMarkerPath(target.dir, f.file);
        if (!existsSync(abs)) {
          modifiedExternally = true;
          continue;
        }
        try {
          const cur = getByPointer(JSON.parse(readFileSync(abs, "utf8")), f.pointer);
          if (cur === undefined || hashValue(cur) !== f.wroteHash) modifiedExternally = true;
        } catch {
          modifiedExternally = true;
        }
      }

      // §12.2 state is integrity-derived and never requires an (usually
      // unresolvable) registryVersion: partial from marker lastResult, stale on
      // integrity drift (missing recorded paths OR a json-key that no longer
      // hashes to wroteHash), current otherwise. entry.version is informational.
      let state: string = "current";
      if (entry.lastResult === "partial") state = "partial";
      if (missing.length || modifiedExternally) state = "stale";
      notes.push(`${target.dir}: ${state} (version ${entry.version ?? "unknown"})`);
      if (modifiedExternally) notes.push(`${target.dir}: modified-externally (json-key drift)`);
    }

    const display = byId.get(id)?.displayName ?? id;
    reports.push({
      productId: id,
      displayName: display,
      success: true,
      skipped: false,
      message: `${display}: ${anyPresent ? "installed" : "not installed"}`,
      assets: { skills: 0, agents: 0, commands: 0, mcp: 0, hooks: 0 },
      actions: [],
      notes,
    });
  }

  emitReport(options, "status", resolution, reports);
  return hadParseError ? 1 : 0;
}

// ---------------------------------------------------------------------------
// uninstall verb (marker-driven exact removal)
// ---------------------------------------------------------------------------

function isSharedDiscoveryDir(configDir: string, abs: string): boolean {
  const shared = [
    join(configDir, "skills"),
    join(configDir, "agents"),
    join(configDir, "commands"),
    markerDirFor(configDir),
    join(markerDirFor(configDir), "products"),
  ];
  return shared.includes(abs);
}

function tryRemoveEmptyDir(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function removeMarkerEntry(
  entry: MarkerProduct,
  target: Target,
  options: Options,
  actions: Action[],
): void {
  // Config entries first (json-key, hooks-entry), then payload dirs/files.
  for (const f of entry.files) {
    if (f.kind === "json-key") {
      const abs = fromMarkerPath(target.dir, f.file);
      const disp = `${f.file}${f.pointer}`;
      if (!existsSync(abs)) {
        actions.push({ kind: "remove", target: disp, result: "skipped", detail: "file absent" });
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(readFileSync(abs, "utf8"));
      } catch {
        actions.push({ kind: "remove", target: disp, result: "skipped", detail: "corrupt config; manual-review" });
        continue;
      }
      const cur = getByPointer(obj, f.pointer);
      if (cur === undefined) {
        actions.push({ kind: "remove", target: disp, result: "skipped", detail: "already gone" });
        continue;
      }
      if (hashValue(cur) !== f.wroteHash) {
        actions.push({ kind: "remove", target: disp, result: "skipped", detail: `user changed this; remove ${f.pointer} manually` });
        continue;
      }
      if (f.prior !== undefined && f.prior !== null) {
        setByPointer(obj, f.pointer, f.prior);
        actions.push({ kind: "restore-prior", target: disp, result: options.dryRun ? "planned" : "ok" });
      } else {
        deleteByPointer(obj, f.pointer);
        actions.push({ kind: "remove", target: disp, result: options.dryRun ? "planned" : "ok" });
      }
      if (!options.dryRun) {
        backupConfigFile(target.dir, abs, options);
        atomicWriteJson(abs, obj, options);
      }
    } else if (f.kind === "hooks-entry") {
      const abs = fromMarkerPath(target.dir, f.file);
      const disp = `${f.file}#${f.event}`;
      if (!existsSync(abs)) {
        actions.push({ kind: "remove", target: disp, result: "skipped", detail: "file absent" });
        continue;
      }
      let settings: Record<string, unknown>;
      try {
        settings = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
      } catch {
        actions.push({ kind: "remove", target: disp, result: "skipped", detail: "corrupt settings.json; manual-review" });
        continue;
      }
      const hooksObj =
        settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
          ? (settings.hooks as Record<string, unknown>)
          : {};
      const arr = Array.isArray(hooksObj[f.event]) ? (hooksObj[f.event] as unknown[]) : [];
      const kept = arr.filter((g) => !containsOwner(g, f.ownerMatch.commandContains));
      if (kept.length) hooksObj[f.event] = kept;
      else delete hooksObj[f.event];
      settings.hooks = hooksObj;
      actions.push({ kind: "remove", target: disp, result: options.dryRun ? "planned" : "ok" });
      if (!options.dryRun) {
        backupConfigFile(target.dir, abs, options);
        atomicWriteJson(abs, settings, options);
      }
    }
  }

  for (const f of entry.files) {
    if (f.kind !== "dir" && f.kind !== "file") continue;
    const abs = fromMarkerPath(target.dir, f.path);
    if (isSharedDiscoveryDir(target.dir, abs)) {
      actions.push({ kind: "remove", target: f.path, result: "skipped", detail: "shared discovery dir preserved" });
      continue;
    }
    if (!existsSync(abs)) {
      actions.push({ kind: "remove", target: f.path, result: "skipped", detail: "absent" });
      continue;
    }
    if (options.dryRun) {
      log(options, `  dry-run: remove ${abs}`);
      actions.push({ kind: "remove", target: f.path, result: "planned" });
    } else {
      rmSync(abs, { recursive: true, force: true });
      actions.push({ kind: "remove", target: f.path, result: "ok" });
    }
  }
}

// v1/legacy marker mode: remove only product-prefixed paths this convention would
// have created, signature/prefix-gated; never touch shared JSON config.
function heuristicUninstall(
  id: string,
  target: Target,
  options: Options,
  actions: Action[],
  notes: string[],
): void {
  notes.push(`${target.dir}: v1 marker — heuristic removal (shared JSON config left for manual-review)`);
  const removePath = (abs: string): void => {
    if (!existsSync(abs)) return;
    if (options.dryRun) {
      log(options, `  dry-run: remove ${abs}`);
      actions.push({ kind: "remove", target: toMarkerPath(target.dir, abs), result: "planned" });
    } else {
      rmSync(abs, { recursive: true, force: true });
      actions.push({ kind: "remove", target: toMarkerPath(target.dir, abs), result: "ok" });
    }
  };

  const skillsDir = join(target.dir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = join(skillsDir, entry.name);
      if (entry.name.startsWith(`${id}-`) || skillSignatureMatches(abs, id)) removePath(abs);
    }
  }
  removePath(join(target.dir, "commands", id));
  const agentsDir = join(target.dir, "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(`${id}-`)) removePath(join(agentsDir, entry.name));
    }
  }
}

function runUninstall(options: Options, registry: Registry): number {
  const resolution = resolveTargets(options);
  if (!resolution.cliPresent) {
    if (!options.json) console.log("Claude not detected (no config dir or install marker present).");
    emitReport(options, "uninstall", resolution, []);
    return 2;
  }

  const byId = new Map(registry.products.map((p) => [p.id, p]));
  const markers = new Map<string, MarkerRaw>();
  for (const target of resolution.targets) markers.set(target.dir, readMarkerRaw(target.dir));

  const idsPresent = new Set<string>();
  for (const target of resolution.targets) {
    const m = markers.get(target.dir);
    if (!m) continue;
    if (m.v2) Object.keys(m.v2.products).forEach((id) => idsPresent.add(id));
    else if (m.legacy?.products) m.legacy.products.forEach((p) => idsPresent.add(p.id));
  }

  let selected: string[];
  if (options.all) selected = [...idsPresent];
  else if (options.productIds.length) selected = options.productIds;
  else throw new Error("no products selected; pass product ids or --all");

  const reports: InstallReport[] = [];
  for (const id of selected) {
    const notes: string[] = [];
    const actions: Action[] = [];
    let heuristic = false;
    let anyRemoved = false;

    for (const target of resolution.targets) {
      const m = markers.get(target.dir);
      if (!m) continue;
      if (m.corrupt) {
        notes.push(`${target.dir}: corrupt marker; skipped`);
        continue;
      }
      if (m.legacy && !m.v2) {
        heuristic = true;
        heuristicUninstall(id, target, options, actions, notes);
        if (m.legacy.products) m.legacy.products = m.legacy.products.filter((p) => p.id !== id);
        anyRemoved = true;
        continue;
      }
      const entry = m.v2?.products[id];
      if (!entry) {
        notes.push(`${target.dir}: not installed`);
        continue;
      }
      removeMarkerEntry(entry, target, options, actions);
      if (m.v2) delete m.v2.products[id];
      anyRemoved = true;
    }

    if (options.purgeBinaries) {
      const product = byId.get(id);
      if (product) purgeProductBinary(product, options, actions, notes);
    }

    const display = byId.get(id)?.displayName ?? id;
    const report: InstallReport = {
      productId: id,
      displayName: display,
      success: true,
      skipped: false,
      message: `${display}: ${anyRemoved ? (options.dryRun ? "would remove" : "removed") : "not installed"}`,
      assets: { skills: 0, agents: 0, commands: 0, mcp: 0, hooks: 0 },
      actions,
      notes,
    };
    if (heuristic) report.heuristic = true;
    reports.push(report);
  }

  // Write back / delete markers.
  for (const target of resolution.targets) {
    const m = markers.get(target.dir);
    if (!m) continue;
    if (m.v2) {
      if (Object.keys(m.v2.products).length === 0) {
        if (options.dryRun) {
          log(options, `  dry-run: remove ${markerPathFor(target.dir)}`);
        } else {
          rmSync(markerPathFor(target.dir), { force: true });
          tryRemoveEmptyDir(markerDirFor(target.dir));
        }
      } else {
        m.v2.updatedAt = new Date().toISOString();
        flushMarkerV2(target.dir, m.v2, options);
      }
    } else if (m.legacy) {
      const remaining = m.legacy.products?.length ?? 0;
      if (remaining === 0) {
        if (options.dryRun) log(options, `  dry-run: remove ${markerPathFor(target.dir)}`);
        else {
          rmSync(markerPathFor(target.dir), { force: true });
          tryRemoveEmptyDir(markerDirFor(target.dir));
        }
      } else if (!options.dryRun) {
        atomicWriteJson(markerPathFor(target.dir), m.legacy, options);
      }
    }
  }

  emitReport(options, "uninstall", resolution, reports);
  return 0;
}

function purgeProductBinary(product: Product, options: Options, actions: Action[], notes: string[]): void {
  try {
    if (product.install.type === "npm-global" && product.install.package) {
      run("npm", ["rm", "-g", product.install.package], options);
      actions.push({ kind: "remove", target: product.install.package, result: options.dryRun ? "planned" : "ok", detail: "npm rm -g" });
    } else if (product.install.type === "cargo") {
      const crate = product.install.crate ?? product.install.package;
      if (crate) {
        run("cargo", ["uninstall", crate], options);
        actions.push({ kind: "remove", target: crate, result: options.dryRun ? "planned" : "ok", detail: "cargo uninstall" });
      }
    }
    notes.push("--purge-binaries removed the machine-scoped binary; other CLIs referencing it will lose it too");
  } catch (err) {
    notes.push(`binary purge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Report emission
// ---------------------------------------------------------------------------

function emitReport(options: Options, verb: Verb, resolution: Resolution, reports: InstallReport[]): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          claudeHome: resolution.primary,
          contract: "1.1",
          verb,
          dryRun: options.dryRun,
          configDirs: resolution.targets.map((t) => t.dir),
          reports,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("");
  for (const report of reports) {
    const status = report.success ? (report.skipped ? "manual" : "ok") : "failed";
    console.log(`[${status}] ${report.message}`);
    for (const note of report.notes) console.log(`  ${note}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const registry = loadRegistry(options.registryPath);

  let code = 0;
  if (options.verb === "install") code = runInstall(options, registry);
  else if (options.verb === "status") code = runStatus(options, registry);
  else code = runUninstall(options, registry);

  if (code) process.exit(code);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
