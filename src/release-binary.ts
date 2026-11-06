/**
 * release-binary.ts — prebuilt-binary acquisition from a GitHub release, sha256-verified.
 *
 * A `cargo` product whose registry entry carries an `install.release` block (wicked-estate) is
 * installed from the release's prebuilt archive for this platform, verified against the
 * release's own checksum file, into ~/.local/bin. `cargo install` is the fallback ONLY when the
 * release has no archive for this platform (or the platform has no known target triple). Any
 * other failure (network, API error, missing or mismatching checksum, a malformed archive) fails
 * the product with the reason and a fix; it never silently installs something unverified and it
 * never falls back to a toolchain the user may not have.
 *
 * node: builtins only (INTERFACE.md §1.1): every install-<cli>.ts imports this module, the same
 * way they import ./types.js. Not named install-*.js, so the picker never mistakes it for a CLI
 * script (detector.ts discoverCliScripts).
 *
 * The scripts are synchronous; downloading is not. `acquireRelease` therefore runs this same file
 * as a child process (`node release-binary.js --wicked-release-worker <json>`) and reads one JSON
 * result line from its stdout.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseSpec {
  /** owner/repo whose GitHub releases carry the prebuilt archives. */
  githubRepo: string;
  /** Executables the archive must contain; all of them are installed (one without the other is broken). */
  binaries: string[];
  /** Archive name prefix: `<prefix>-<version>-<triple>.tar.gz|zip`. Default: the repo name. */
  assetPrefix?: string;
  /** Checksum file published in the same release (`<sha256>  <asset>` lines). Default SHA256SUMS. */
  checksums?: string;
}

interface CargoishInstall {
  type?: string;
  crate?: string;
  crates?: string[];
  package?: string;
  version?: string;
  release?: ReleaseSpec;
}

const WORKER_FLAG = "--wicked-release-worker";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Platform + locations
// ---------------------------------------------------------------------------

/** glibc Linux only: the `-unknown-linux-gnu` archives do not run on musl (Alpine). */
function linuxIsGlibc(): boolean {
  try {
    const report = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } };
    return typeof report.header?.glibcVersionRuntime === "string";
  } catch {
    return false;
  }
}

/** The Rust target triple the release archives are named by, or undefined (⇒ cargo). */
export function releaseTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch, glibc?: boolean): string | undefined {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "darwin-arm64": return "aarch64-apple-darwin";
    case "darwin-x64": return "x86_64-apple-darwin";
    case "win32-x64": return "x86_64-pc-windows-msvc";
    case "linux-x64":
    case "linux-arm64":
      if (!(glibc ?? linuxIsGlibc())) return undefined;
      return arch === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
    default: return undefined;
  }
}

export function exeName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" && !/\.exe$/i.test(name) ? `${name}.exe` : name;
}

/** Where release binaries go: ~/.local/bin on every platform (garden's and Codex's resolvers look there). */
export function releaseBinDir(home: string = homedir()): string {
  return join(home, ".local", "bin");
}

export function cargoBinDir(home: string = homedir()): string {
  return join(home, ".cargo", "bin");
}

function isRunnableFile(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(delimiter).filter((d) => d.length > 0);
}

export interface FoundBinary {
  path: string;
  /** "PATH", "~/.local/bin" or "~/.cargo/bin". */
  source: string;
}

/**
 * Where an installed binary actually is: PATH first, then the release bin dir, then cargo's.
 * Read-only (filesystem lookups, nothing spawned).
 */
export function findInstalledBinary(
  name: string,
  opts: { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform } = {},
): FoundBinary | undefined {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const file = exeName(name, platform);
  for (const dir of pathDirs(env)) {
    const p = join(dir, file);
    if (isRunnableFile(p, platform)) return { path: p, source: "PATH" };
  }
  const local = join(releaseBinDir(home), file);
  if (isRunnableFile(local, platform)) return { path: local, source: "~/.local/bin" };
  const cargo = join(cargoBinDir(home), file);
  if (isRunnableFile(cargo, platform)) return { path: cargo, source: "~/.cargo/bin" };
  return undefined;
}

/** Is `dir` one of the PATH entries? (Compared by resolved path when both exist.) */
export function dirOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = (d: string): string => {
    try {
      return realpathSync(d);
    } catch {
      return d.replace(/[\\/]+$/, "");
    }
  };
  const target = norm(dir);
  return pathDirs(env).some((d) => norm(d) === target);
}

/** The one-line PATH fix for this platform. */
export function pathFix(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? `add ${dir} to your user PATH (System Properties → Environment Variables), then open a new terminal`
    : `add it to PATH: echo 'export PATH="${dir}:$PATH"' >> ~/.profile (or your shell's rc file), then open a new terminal`;
}

// ---------------------------------------------------------------------------
// The worker (async; runs in a child process)
// ---------------------------------------------------------------------------

interface WorkerRequest {
  repo: string;
  binaries: string[];
  prefix: string;
  checksums: string;
  triple: string;
  version?: string;
  binDir: string;
  apiBase: string;
}

export type ReleaseOutcome =
  | { status: "installed"; tag: string; asset: string; sha256: string; binDir: string; paths: string[] }
  | { status: "current"; tag: string; binDir: string; paths: string[] }
  | { status: "no-asset"; tag: string; detail: string }
  | { status: "failed"; message: string };

function apiBase(env: NodeJS.ProcessEnv): string {
  // Test seam (a local fixture server); the default is GitHub.
  return (env.WICKED_RELEASE_API_BASE ?? "https://api.github.com").replace(/\/+$/, "");
}

async function getOk(url: string, accept: string): Promise<Response> {
  const res = await fetch(url, { headers: { accept, "user-agent": "wicked-installer" }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  return res;
}

/** Parse a `sha256sum`-style file: `<64 hex>  [*]<name>` per line. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** Regular files only, symlinks never followed. */
function findFile(dir: string, file: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isDirectory()) {
      const sub = findFile(full, file);
      if (sub) return sub;
    } else if (st.isFile() && entry === file) {
      return full;
    }
  }
  return undefined;
}

function versionOf(bin: string): string {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return res.status === 0 ? `${res.stdout ?? ""}`.trim() : "";
}

export async function runWorker(req: WorkerRequest): Promise<ReleaseOutcome> {
  const releaseUrl = req.version
    ? `${req.apiBase}/repos/${req.repo}/releases/tags/v${req.version.replace(/^v/, "")}`
    : `${req.apiBase}/repos/${req.repo}/releases/latest`;
  let release: { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  try {
    release = (await (await getOk(releaseUrl, "application/vnd.github+json")).json()) as typeof release;
  } catch (err) {
    return { status: "failed", message: `could not read the ${req.repo} release (${err instanceof Error ? err.message : String(err)})` };
  }
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const isZip = req.triple.includes("windows");
  const asset = assets.find((a) =>
    typeof a.name === "string" && typeof a.browser_download_url === "string" &&
    a.name.startsWith(`${req.prefix}-`) && a.name.includes(req.triple) &&
    (isZip ? a.name.endsWith(".zip") : /\.(tar\.gz|tgz)$/.test(a.name)),
  );
  if (!asset || !asset.name || !asset.browser_download_url) {
    return { status: "no-asset", tag, detail: `release ${tag || "(untagged)"} of ${req.repo} has no ${req.triple} archive` };
  }

  // Already converged? Every binary present, and the primary one reports the release version.
  const version = tag.replace(/^v/, "");
  const dests = req.binaries.map((b) => join(req.binDir, exeName(b)));
  if (version && dests.every((d) => isRunnableFile(d, process.platform)) && versionOf(dests[0]).split(/\s+/).includes(version)) {
    return { status: "current", tag, binDir: req.binDir, paths: dests };
  }

  const sums = assets.find((a) => a.name === req.checksums && typeof a.browser_download_url === "string");
  if (!sums || !sums.browser_download_url) {
    return { status: "failed", message: `release ${tag} of ${req.repo} publishes no ${req.checksums}, so ${asset.name} cannot be verified — nothing was installed` };
  }

  const tmp = mkdtempSync(join(tmpdir(), "wicked-release-"));
  try {
    let expected: string | undefined;
    try {
      expected = parseChecksums(await (await getOk(sums.browser_download_url, "application/octet-stream")).text()).get(asset.name);
    } catch (err) {
      return { status: "failed", message: `could not download ${req.checksums} for ${tag} (${err instanceof Error ? err.message : String(err)}) — nothing was installed` };
    }
    if (!expected) {
      return { status: "failed", message: `${req.checksums} in ${tag} has no entry for ${asset.name}, so it cannot be verified — nothing was installed` };
    }

    let data: Buffer;
    try {
      data = Buffer.from(await (await getOk(asset.browser_download_url, "application/octet-stream")).arrayBuffer());
    } catch (err) {
      return { status: "failed", message: `could not download ${asset.name} (${err instanceof Error ? err.message : String(err)}) — nothing was installed` };
    }
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) {
      return { status: "failed", message: `sha256 mismatch for ${asset.name}: the release's ${req.checksums} says ${expected}, the download is ${actual} — refusing to install it; nothing was installed` };
    }

    const archive = join(tmp, asset.name);
    writeFileSync(archive, data);
    const out = join(tmp, "x");
    mkdirSync(out);
    // bsdtar (macOS, Windows 10+) reads zip as well; GNU tar does not, so zip on Linux uses unzip.
    const extract = isZip && process.platform !== "win32"
      ? spawnSync("unzip", ["-q", "-o", archive, "-d", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      : spawnSync("tar", ["-xf", archive, "-C", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (extract.status !== 0) {
      return { status: "failed", message: `could not extract ${asset.name}: ${`${extract.stderr ?? ""}${extract.error?.message ?? ""}`.trim() || `exit ${extract.status}`} — nothing was installed` };
    }

    const found: Array<[string, string]> = [];
    for (const bin of req.binaries) {
      const src = findFile(out, exeName(bin));
      if (!src) return { status: "failed", message: `${asset.name} does not contain ${exeName(bin)} — nothing was installed` };
      found.push([src, join(req.binDir, exeName(bin))]);
    }

    mkdirSync(req.binDir, { recursive: true });
    // Stage every binary next to its destination first, then rename: a failure while staging
    // leaves the previous binaries untouched, and each rename replaces its file atomically.
    const staged: Array<[string, string]> = [];
    try {
      for (const [src, dest] of found) {
        const tmpDest = `${dest}.wicked-tmp-${process.pid}`;
        copyFileSync(src, tmpDest);
        if (process.platform !== "win32") chmodSync(tmpDest, 0o755);
        staged.push([tmpDest, dest]);
      }
      for (const [tmpDest, dest] of staged) renameSync(tmpDest, dest);
    } catch (err) {
      for (const [tmpDest] of staged) rmSync(tmpDest, { force: true });
      return { status: "failed", message: `could not write to ${req.binDir} (${err instanceof Error ? err.message : String(err)})` };
    }
    return { status: "installed", tag, asset: asset.name, sha256: actual, binDir: req.binDir, paths: found.map(([, d]) => d) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The synchronous API the install scripts call
// ---------------------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);

/** Download + verify + install, synchronously (a child node process does the async work). */
export function acquireRelease(
  spec: ReleaseSpec,
  opts: { triple: string; version?: string; binDir?: string; env?: NodeJS.ProcessEnv },
): ReleaseOutcome {
  const env = opts.env ?? process.env;
  const req: WorkerRequest = {
    repo: spec.githubRepo,
    binaries: spec.binaries,
    prefix: spec.assetPrefix ?? spec.githubRepo.split("/").pop() ?? spec.githubRepo,
    checksums: spec.checksums ?? "SHA256SUMS",
    triple: opts.triple,
    version: opts.version,
    binDir: opts.binDir ?? releaseBinDir(),
    apiBase: apiBase(env),
  };
  const res = spawnSync(process.execPath, [THIS_FILE, WORKER_FLAG, JSON.stringify(req)], {
    encoding: "utf8",
    env,
    timeout: DOWNLOAD_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = `${res.stdout ?? ""}`.trim().split(/\r?\n/);
  try {
    const parsed = JSON.parse(lines[lines.length - 1] ?? "") as ReleaseOutcome;
    if (parsed && typeof parsed.status === "string") return parsed;
  } catch {
    /* fall through */
  }
  const why = res.error ? res.error.message : `${res.stderr ?? ""}`.trim() || `exit ${res.status ?? "?"}`;
  return { status: "failed", message: `the release download did not finish (${why}) — nothing was installed` };
}

export type ReleaseStep =
  /** Installed (or already current) from the release — or, under --dry-run, planned. */
  | { action: "done"; notes: string[]; detail: string }
  /** No prebuilt binary for this platform: the caller builds with cargo. */
  | { action: "cargo"; notes: string[]; reason: string };

function cratesOf(install: CargoishInstall): string[] {
  const single = install.crate ?? install.package;
  return Array.isArray(install.crates) && install.crates.length > 0 ? install.crates : single ? [single] : [];
}

/** The honest message when cargo is needed and absent — with a fix that works on this machine. */
export function cargoMissingMessage(productId: string, install: CargoishInstall, reason?: string): string {
  const crates = cratesOf(install);
  const why = reason ?? (install.release ? `no prebuilt ${productId} binary exists for ${process.platform}-${process.arch}` : `${productId} is built from source`);
  return `${why}, and building it from source needs the Rust toolchain, which is not installed (cargo not found). ` +
    `Fix: install Rust from https://rustup.rs, open a new terminal, then run: cargo install ${crates.join(" ")}`;
}

/**
 * The release half of a `cargo` product's acquisition. Returns `done` (installed / current /
 * planned), or `cargo` when the release has no binary for this platform. Throws with the reason
 * and a fix on any other failure — no cargo fallback for a network or verification failure.
 */
export function acquireFromRelease(
  productId: string,
  install: CargoishInstall,
  ctx: { dryRun: boolean; log: (line: string) => void; env?: NodeJS.ProcessEnv; home?: string },
): ReleaseStep {
  const spec = install.release;
  const crates = cratesOf(install);
  if (!spec || !spec.githubRepo || !Array.isArray(spec.binaries) || spec.binaries.length === 0) {
    return { action: "cargo", notes: [], reason: `${productId} has no prebuilt release in the registry` };
  }
  const env = ctx.env ?? process.env;
  const triple = releaseTriple();
  if (!triple) {
    const reason = `no prebuilt ${productId} binary exists for ${process.platform}-${process.arch}${process.platform === "linux" ? " (or this Linux is not glibc-based)" : ""}`;
    ctx.log(`  ${reason}; building from source with cargo`);
    return { action: "cargo", notes: [`${reason}; built from source with cargo`], reason };
  }
  const binDir = releaseBinDir(ctx.home);
  const where = install.version ? `release v${install.version}` : "latest release";
  if (ctx.dryRun) {
    ctx.log(`  dry-run: GET ${apiBase(env)}/repos/${spec.githubRepo}/releases/${install.version ? `tags/v${install.version}` : "latest"}`);
    ctx.log(`  dry-run: download the ${triple} archive and ${spec.checksums ?? "SHA256SUMS"}; verify its sha256`);
    ctx.log(`  dry-run: install ${spec.binaries.join(", ")} to ${binDir}`);
    ctx.log(`  dry-run: (only if the release has no ${triple} archive: cargo install ${crates.join(" ")})`);
    return { action: "done", notes: [`would install ${spec.binaries.join(" + ")} from the ${spec.githubRepo} ${where} (${triple}, sha256-verified) to ${binDir}`], detail: "planned github-release" };
  }

  ctx.log(`  fetching ${spec.binaries.join(" + ")} from the ${spec.githubRepo} ${where} (${triple})...`);
  const outcome = acquireRelease(spec, { triple, version: install.version, binDir, env });
  const pathNote = (): string[] => dirOnPath(binDir, env)
    ? []
    : [`${binDir} is not on PATH: the MCP entries use the absolute path, but to run ${spec.binaries[0]} from a shell, ${pathFix(binDir)}`];
  switch (outcome.status) {
    case "installed":
      return {
        action: "done",
        detail: "github-release (sha256 verified)",
        notes: [`installed ${spec.binaries.join(" + ")} ${outcome.tag} (${outcome.asset}, sha256 ${outcome.sha256.slice(0, 12)}… verified against the release's ${spec.checksums ?? "SHA256SUMS"}) to ${binDir}`, ...pathNote()],
      };
    case "current":
      return { action: "done", detail: "github-release (already current)", notes: [`${spec.binaries.join(" + ")} ${outcome.tag} already installed in ${binDir}`, ...pathNote()] };
    case "no-asset": {
      const reason = `${outcome.detail} (no prebuilt binary for this platform)`;
      ctx.log(`  ${reason}; building from source with cargo`);
      return { action: "cargo", notes: [`${reason}; built from source with cargo`], reason };
    }
    case "failed":
    default:
      throw new Error(
        `${productId}: ${outcome.status === "failed" ? outcome.message : "unexpected release outcome"}. ` +
        `Fix: check the network and re-run \`npx wicked-installer install ${productId}\`; ` +
        `or download it from https://github.com/${spec.githubRepo}/releases and put ${spec.binaries.join(" + ")} in ${binDir}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Child-process entry
// ---------------------------------------------------------------------------

function invokedAsWorker(): boolean {
  if (process.argv[2] !== WORKER_FLAG || !process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(THIS_FILE);
  } catch {
    return false;
  }
}

if (invokedAsWorker()) {
  let req: WorkerRequest | undefined;
  try {
    req = JSON.parse(process.argv[3] ?? "") as WorkerRequest;
  } catch {
    req = undefined;
  }
  // Exit as soon as the result is written: fetch's keep-alive sockets would otherwise hold the
  // worker (and the synchronous caller) open until the server closes them.
  const done = (o: ReleaseOutcome): void => {
    process.stdout.write(`${JSON.stringify(o)}\n`, () => process.exit(0));
  };
  if (!req) {
    done({ status: "failed", message: "release worker: bad request" });
  } else {
    runWorker(req).then(done, (err: unknown) => done({ status: "failed", message: err instanceof Error ? err.message : String(err) }));
  }
}

