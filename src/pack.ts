/**
 * pack.ts — third-party skill-pack acquisition + install (extension contract).
 *
 * One-implementation rule (SKILL-RATIONALIZATION §5 gap 7):
 *   - ACQUISITION + STAGING live here (this file) — the single install path.
 *     `npx wicked-garden pack install …` DELEGATES to `wicked-installer pack
 *     add …`, so garden and third parties travel the same code.
 *   - VALIDATION + REGISTRATION live in wicked-garden's shipped Python
 *     (`pack check` / `pack register`) — this file shells out to the garden
 *     CLI and never re-implements either.
 *
 * Flow of `pack add <source>`:
 *   1. resolve the source: existing local dir, or an npm spec fetched into a
 *      staging prefix (`npm install --prefix <staging> <spec>`);
 *   2. conformance-check via `wicked-garden pack check` (fail-closed;
 *      `--force` to override);
 *   3. copy the pack to the canonical install home
 *      (~/.something-wicked/wicked-garden/packs/installed/<name>);
 *   4. make skills visible to Claude Code: packs that are NOT already Claude
 *      Code plugins get their skills copied into <configDir>/skills/<skill>/ of
 *      every active Claude config dir (CLAUDE_CONFIG_DIR when set, else
 *      ~/.claude), ownership-aware — see "Install steps" below (#48)
 *      (other CLIs: the per-CLI install-script seam, INTERFACE.md — not
 *      wired for packs yet, stated honestly in the README);
 *   5. register with garden (`wicked-garden pack register <dir> --source …`)
 *      so the runtime catalog, crew routing, and peer-floor probe see it.
 *
 * `pack remove <name>` reverses 3-5. `pack list` / `pack check` delegate.
 */

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { resolveClaudeConfigDirs } from "./claude-plugin.js";

const MANIFEST = "wicked-pack.json";

interface PackManifest {
  name: string;
  vendor: string;
  version: string;
  skills_dir?: string;
  provenance?: { source?: string; publisher?: string };
}

interface AddFlags {
  sourceUrl?: string;
  dryRun: boolean;
  force: boolean;
}

function installedHome(): string {
  return join(homedir(), ".something-wicked", "wicked-garden", "packs", "installed");
}

// ---------------------------------------------------------------------------
// Spawn helpers. Windows rule (INTERFACE.md §1.1): npm/npx — and any other
// npm-installed bin like `wicked-garden` — are .cmd shims that need
// { shell: true }, and every arg must then be cmd.exe-quoted via winQuote.
// ---------------------------------------------------------------------------

function isCmdShim(cmd: string): boolean {
  return process.platform === "win32" && /^(npm|npx|wicked-garden)$/i.test(cmd);
}

/**
 * Quote ONE argument for cmd.exe when spawning a .cmd shim with { shell: true }.
 * Verbatim from INTERFACE.md §1.1 (CommandLineToArgvW backslash/quote rule).
 */
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

function shimArgs(cmd: string, args: string[]): { args: string[]; shell: boolean } {
  if (!isCmdShim(cmd)) return { args, shell: false };
  return { args: args.map(winQuote), shell: true };
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number; out: string } {
  const prepared = shimArgs(cmd, args);
  const res = spawnSync(cmd, prepared.args, {
    encoding: "utf8",
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: prepared.shell,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? 1, out };
}

/** Run and stream output straight through (for user-facing delegated verbs). */
function runThrough(cmd: string, args: string[]): number {
  const prepared = shimArgs(cmd, args);
  const res = spawnSync(cmd, prepared.args, { stdio: "inherit", shell: prepared.shell });
  return res.status ?? 1;
}

function which(binary: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [binary], { stdio: "ignore" }).status === 0;
}

/**
 * The garden pack CLI — validation + registration single implementation.
 * Resolution: WICKED_GARDEN_BIN → `wicked-garden` on PATH → npx.
 */
function gardenArgv(packArgs: string[]): string[] {
  const override = process.env.WICKED_GARDEN_BIN;
  if (override) return [override, "pack", ...packArgs];
  if (which("wicked-garden")) return ["wicked-garden", "pack", ...packArgs];
  return ["npx", "-y", "wicked-garden@latest", "pack", ...packArgs];
}

function gardenPack(packArgs: string[]): number {
  const argv = gardenArgv(packArgs);
  return runThrough(argv[0], argv.slice(1));
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/** npm spec → bare package name ("acme-pack@1.2.3" → "acme-pack", scoped kept). */
export function npmSpecName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

interface ResolvedSource {
  dir: string;
  origin: string;        // provenance source recorded at registration
  staging?: string;      // temp dir to clean up
}

function resolveSource(source: string, flags: AddFlags): ResolvedSource {
  const local = resolve(source);
  if (existsSync(join(local, MANIFEST))) {
    return { dir: local, origin: flags.sourceUrl ?? local };
  }
  if (existsSync(local)) {
    throw new Error(`${local} exists but has no ${MANIFEST} — not a pack`);
  }

  // npm spec. --ignore-scripts: this is pure acquisition/staging — a pack is
  // data (manifest + skills), so its lifecycle scripts never need to run and
  // letting them run here would be an avoidable supply-chain hole.
  const staging = mkdtempSync(join(tmpdir(), "wicked-pack-"));
  console.log(chalk.dim(`  fetching ${source} from npm...`));
  const res = run("npm", ["install", "--prefix", staging, "--ignore-scripts", "--no-fund", "--no-audit", "--loglevel=error", source]);
  if (res.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`npm install failed for ${source}:\n${res.out.trim()}`);
  }
  const dir = join(staging, "node_modules", ...npmSpecName(source).split("/"));
  if (!existsSync(join(dir, MANIFEST))) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${source} installed but has no ${MANIFEST} at its root — not a pack`);
  }
  return { dir, origin: flags.sourceUrl ?? `npm:${source}`, staging };
}

/** Pack names double as filesystem path segments (install home, remove) —
 *  restrict to a single kebab-case segment so a hostile manifest can never
 *  traverse (`../../…`) out of the packs directory. Mirrors garden's rule. */
const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function assertSafeName(name: string): string {
  if (!SAFE_NAME.test(name) || name.length > 64) {
    throw new Error(`pack name ${JSON.stringify(name)} must be kebab-case (max 64 chars) — refusing to use it as a path`);
  }
  return name;
}

function readManifest(dir: string): PackManifest {
  const parsed = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as PackManifest;
  if (!parsed.name) throw new Error(`${MANIFEST} has no "name"`);
  assertSafeName(parsed.name);
  return parsed;
}

// ---------------------------------------------------------------------------
// Install steps — ownership-aware (wicked-installer#48)
//
// Policy (C1, settled with the operator): a pack's skills are copied into each ACTIVE Claude
// config dir's skills/ (resolveClaudeConfigDirs: --claude-home is not a pack flag, so
// CLAUDE_CONFIG_DIR when set, else ~/.claude). Each dir gets a record
// <configDir>/wicked-installer/packs/<name>.json naming the installation (id, source, version,
// destination) and the sha256 of every file it wrote. Before ANYTHING changes, every dir is
// classified against its record:
//   unchanged  — on disk exactly as recorded           → overwritten / pruned freely
//   missing    — recorded, gone                         → repaired
//   new        — incoming, nothing there                → written
//   obsolete   — recorded, unchanged, no longer shipped → pruned
//   edited     — recorded, content differs (or obsolete and edited)  → HOLD
//   added      — a file in an owned skill dir the pack never wrote   → HOLD
//   foreign    — an incoming skill dir exists that this pack does not own → HOLD
// Any HOLD keeps the whole pack as it was (canonical copy, skills, registration) and reports
// the paths with the installed/incoming versions; nothing is merged. Removal deletes only
// unchanged owned files, keeps and reports the rest, and says the cleanup is incomplete.
// A pack shipped as a Claude Code plugin keeps the native exception: no skills are copied.
// ---------------------------------------------------------------------------

const RECORD_SCHEMA = 1;
/** OS litter that never counts as a user's edit and may be removed with an owned dir. */
const LITTER = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

interface PackRecord {
  schema: number;
  pack: string;
  vendor?: string;
  version: string;
  source: string;
  installId: string;
  installedAt: string;
  configDir: string;
  skillsRoot: string;
  skills: string[];
  /** "<skill>/<posix path>" → sha256 hex of the bytes this installer wrote. */
  files: Record<string, string>;
  /** Set while an apply is in flight: an interrupted run accepts the old OR the new digest. */
  pending?: { version: string; skills: string[]; files: Record<string, string>; startedAt: string };
}

type FileState = "unchanged" | "missing" | "new" | "obsolete" | "edited" | "added" | "foreign";
const CONFLICTS: ReadonlySet<FileState> = new Set(["edited", "added", "foreign"]);

interface Classified {
  path: string;        // "<skill>/<posix path>" (or "<skill>/" for a whole dir)
  state: FileState;
  note?: string;
}

interface DirPlan {
  configDir: string;
  skillsRoot: string;
  recordFile: string;
  record?: PackRecord;
  /** The record could not be read: fail closed (HOLD on add, keep everything on remove). */
  recordError?: string;
  adopted: string[];
  items: Classified[];
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function fromKey(root: string, key: string): string {
  return join(root, ...key.split("/"));
}

interface TreeEntry { rel: string; kind: "file" | "symlink" | "other" }

/** Every entry under `dir` (lstat, never following a link), as posix paths relative to it. */
function walk(dir: string, prefix = ""): TreeEntry[] {
  const out: TreeEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.push({ rel, kind: "symlink" });
    else if (st.isDirectory()) out.push(...walk(abs, rel));
    else if (st.isFile()) out.push({ rel, kind: "file" });
    else out.push({ rel, kind: "other" });
  }
  return out;
}

function lkind(p: string): "absent" | "file" | "dir" | "other" {
  try {
    const st = lstatSync(p);
    return st.isFile() ? "file" : st.isDirectory() && !st.isSymbolicLink() ? "dir" : "other";
  } catch {
    return "absent";
  }
}

function isLitter(key: string): boolean {
  return LITTER.has(key.split("/").pop() ?? "");
}

/** The pack's skills dir, refused when the manifest points it outside the pack. */
function packSkillsDir(packDir: string, manifest: PackManifest): string {
  const root = resolve(packDir);
  const dir = resolve(root, manifest.skills_dir ?? "skills");
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`skills_dir ${JSON.stringify(manifest.skills_dir)} points outside the pack — refusing it`);
  }
  return dir;
}

interface Incoming {
  skills: string[];
  files: Record<string, string>;
  /** Source path per key, for the copy. */
  sources: Record<string, string>;
  skipped: string[];
}

/** What a pack ships: skill dirs holding a SKILL.md, every regular file in them. Links are never copied. */
function readIncoming(packDir: string, manifest: PackManifest): Incoming {
  const skillsDir = packSkillsDir(packDir, manifest);
  const out: Incoming = { skills: [], files: {}, sources: {}, skipped: [] };
  if (!existsSync(skillsDir)) return out;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    if (lkind(join(skillDir, "SKILL.md")) !== "file") continue;
    out.skills.push(entry.name);
    for (const f of walk(skillDir)) {
      const key = `${entry.name}/${f.rel}`;
      if (f.kind !== "file") {
        out.skipped.push(key);
        continue;
      }
      const src = join(skillDir, ...f.rel.split("/"));
      out.files[key] = sha256File(src);
      out.sources[key] = src;
    }
  }
  out.skills.sort();
  return out;
}

function recordFileFor(configDir: string, name: string): string {
  return join(configDir, "wicked-installer", "packs", `${name}.json`);
}

function readRecord(file: string): { record?: PackRecord; error?: string } {
  if (lkind(file) === "absent") return {};
  if (lkind(file) !== "file") return { error: `${file} is not a regular file` };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PackRecord;
    const problem = recordProblem(parsed);
    if (problem) return { error: `${file} is not a usable pack install record (${problem})` };
    return { record: parsed };
  } catch (err) {
    return { error: `${file} is unreadable (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** A path key the record may hold: "<skill>/<rel>", plain segments only (never "..", ".", absolute, or a backslash). */
function safeKey(key: string): boolean {
  if (key.includes("\\") || key.startsWith("/")) return false;
  const parts = key.split("/");
  return parts.length >= 2 && parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.includes(":"));
}

function safeSkill(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !/[\\/:]/.test(name);
}

function fileMapProblem(files: unknown, label: string): string | undefined {
  if (!files || typeof files !== "object" || Array.isArray(files)) return `${label} is not an object`;
  for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
    if (!safeKey(k)) return `${label} has an unsafe path ${JSON.stringify(k)}`;
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) return `${label}[${JSON.stringify(k)}] is not a sha256`;
  }
  return undefined;
}

/** Why a parsed record cannot be trusted (then nothing it names is touched), or undefined. */
function recordProblem(r: unknown): string | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not an object";
  const rec = r as PackRecord;
  if (!Array.isArray(rec.skills) || !rec.skills.every(safeSkill)) return "skills is not a list of skill names";
  const files = fileMapProblem(rec.files, "files");
  if (files) return files;
  if (rec.pending !== undefined) {
    if (!rec.pending || typeof rec.pending !== "object") return "pending is not an object";
    if (!Array.isArray(rec.pending.skills) || !rec.pending.skills.every(safeSkill)) return "pending.skills is not a list of skill names";
    const pf = fileMapProblem(rec.pending.files, "pending.files");
    if (pf) return pf;
  }
  return undefined;
}

/** A link or a non-directory in place of a directory BETWEEN the skills root and `key` (never followed). */
function linkedBelow(root: string, key: string): boolean {
  const parts = key.split("/");
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    const k = lkind(cur);
    if (k === "absent") return false;
    if (k !== "dir") return true;
  }
  return false;
}

/** Skill names other packs' records claim in this config dir (never adopted by another pack). */
function claimedByOthers(configDir: string, name: string): Set<string> {
  const out = new Set<string>();
  const dir = join(configDir, "wicked-installer", "packs");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f === `${name}.json`) continue;
    const { record } = readRecord(join(dir, f));
    if (record) for (const sk of ownedSkillsOf(record)) out.add(sk);
  }
  return out;
}

/**
 * Where a pre-record install (wicked-installer ≤ 0.8.1) put skills: ~/.claude/skills, always —
 * it ignored CLAUDE_CONFIG_DIR. Legacy ownership is only ever assumed there.
 */
function isLegacyDestination(configDir: string): boolean {
  return resolve(configDir) === resolve(homedir(), ".claude");
}

function writeRecord(file: string, record: PackRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Digests an owned path may have on disk and still be "ours, unchanged". */
function ownedDigests(record: PackRecord): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (files: Record<string, string>) => {
    for (const [k, v] of Object.entries(files)) {
      if (typeof v !== "string") continue;
      if (!out.has(k)) out.set(k, new Set());
      out.get(k)!.add(v);
    }
  };
  add(record.files);
  if (record.pending) add(record.pending.files);
  return out;
}

function ownedSkillsOf(record: PackRecord): Set<string> {
  return new Set([...record.skills, ...(record.pending?.skills ?? [])].filter((s) => typeof s === "string"));
}

/** Files of an on-disk skill dir as key → digest, or undefined if it holds anything but files. */
function treeDigests(skillsRoot: string, skill: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const f of walk(join(skillsRoot, skill))) {
    if (f.kind !== "file") return undefined;
    out[`${skill}/${f.rel}`] = sha256File(join(skillsRoot, skill, ...f.rel.split("/")));
  }
  return out;
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).filter((k) => !isLitter(k)).sort();
  const kb = Object.keys(b).filter((k) => !isLitter(k)).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

function filesOfSkill(files: Record<string, string>, skill: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) if (k.startsWith(`${skill}/`)) out[k] = v;
  return out;
}

/**
 * Classify one config dir. `legacy` = the existing canonical copy's files (an install made
 * before records existed): a skill dir identical to it, or to the incoming copy, is adopted as
 * this pack's own — byte-identical content cannot hold a user's edit. Anything else without a
 * record is foreign.
 */
function classifyDir(configDir: string, name: string, incoming: Incoming, legacy: Incoming | undefined): DirPlan {
  const skillsRoot = join(configDir, "skills");
  const recordFile = recordFileFor(configDir, name);
  const { record, error } = readRecord(recordFile);
  const plan: DirPlan = { configDir, skillsRoot, recordFile, record, recordError: error, adopted: [], items: [] };
  if (error) return plan;

  let owned: Map<string, Set<string>>;
  let ownedSkills: Set<string>;
  // A skill name another pack's record claims here is never this pack's, whether or not its
  // directory currently exists (two owners would let one pack's removal delete the other's).
  const others = claimedByOthers(configDir, name);
  for (const skill of incoming.skills) {
    if (others.has(skill)) plan.items.push({ path: `${skill}/`, state: "foreign", note: "installed by another pack" });
  }
  if (record) {
    owned = ownedDigests(record);
    ownedSkills = ownedSkillsOf(record);
    // A skill this version adds whose destination already exists belongs to someone else.
    for (const skill of incoming.skills) {
      if (!ownedSkills.has(skill) && !others.has(skill) && lkind(join(skillsRoot, skill)) !== "absent") {
        plan.items.push({ path: `${skill}/`, state: "foreign", note: "exists and was not installed by this pack" });
      }
    }
  } else {
    owned = new Map();
    ownedSkills = new Set();
    // No record: a skill dir is this pack's only when an earlier (pre-record) install of THIS
    // pack demonstrably put it there — the pack's canonical copy exists, this is the dir that
    // installer wrote to (~/.claude), no other pack claims the name, and the tree is
    // byte-identical to that canonical copy. Identical bytes alone (a user's own copy) are not
    // ownership.
    const legacyHere = legacy !== undefined && isLegacyDestination(configDir) ? legacy : undefined;
    const candidates = new Set([...incoming.skills, ...(legacyHere?.skills ?? [])]);
    for (const skill of [...candidates].sort()) {
      const kind = lkind(join(skillsRoot, skill));
      if (kind === "absent" || others.has(skill)) continue;
      const disk = kind === "dir" ? treeDigests(skillsRoot, skill) : undefined;
      const matches = disk !== undefined && legacyHere !== undefined &&
        legacyHere.skills.includes(skill) && sameFiles(disk, filesOfSkill(legacyHere.files, skill));
      if (matches) {
        ownedSkills.add(skill);
        for (const [k, v] of Object.entries(disk!)) if (!isLitter(k)) owned.set(k, new Set([v]));
        plan.adopted.push(skill);
      } else {
        plan.items.push({ path: `${skill}/`, state: "foreign", note: legacyHere ? "exists and is not this pack's unmodified earlier copy" : "exists and was not installed by this pack" });
      }
    }
  }

  const seen = new Set<string>();
  // Owned skill dirs: every recorded file, then anything else found in them.
  for (const skill of [...ownedSkills].sort()) {
    const dirKind = lkind(join(skillsRoot, skill));
    if (dirKind !== "dir" && dirKind !== "absent") {
      plan.items.push({ path: `${skill}/`, state: "edited", note: "replaced by something that is not a directory" });
      continue;
    }
    for (const [key, digests] of owned) {
      if (!key.startsWith(`${skill}/`)) continue;
      seen.add(key);
      const abs = fromKey(skillsRoot, key);
      const shipped = key in incoming.files;
      if (linkedBelow(skillsRoot, key)) {
        plan.items.push({ path: key, state: "edited", note: "a directory on its path was replaced by a link or a file" });
        continue;
      }
      const k = lkind(abs);
      if (k === "absent") {
        if (shipped) plan.items.push({ path: key, state: "missing" });
        continue;
      }
      const unchanged = k === "file" && digests.has(sha256File(abs));
      if (!unchanged) plan.items.push({ path: key, state: "edited", note: shipped ? undefined : "no longer shipped, but locally edited" });
      else plan.items.push({ path: key, state: shipped ? "unchanged" : "obsolete" });
    }
    if (dirKind === "dir") {
      for (const f of walk(join(skillsRoot, skill))) {
        const key = `${skill}/${f.rel}`;
        if (seen.has(key) || isLitter(key)) continue;
        seen.add(key);
        plan.items.push({ path: key, state: "added", note: f.kind === "file" ? "not written by this pack" : `a ${f.kind} not written by this pack` });
      }
    }
  }
  // Incoming files not yet accounted for: new (in an owned dir, or a skill dir that is absent).
  for (const key of Object.keys(incoming.files).sort()) {
    if (seen.has(key)) continue;
    const skill = key.split("/")[0];
    if (others.has(skill) || (!ownedSkills.has(skill) && lkind(join(skillsRoot, skill)) !== "absent")) continue; // foreign, reported above
    plan.items.push({ path: key, state: "new" });
  }
  return plan;
}

function conflictsOf(plan: DirPlan): Classified[] {
  return plan.items.filter((i) => CONFLICTS.has(i.state));
}

function printPlan(plan: DirPlan, verbose: boolean): void {
  console.log(`  ${plan.skillsRoot}`);
  if (plan.recordError) {
    console.log(chalk.red(`    record unreadable: ${plan.recordError}`));
    return;
  }
  if (plan.adopted.length > 0) console.log(chalk.dim(`    adopted (identical to this pack's files, installed before records existed): ${plan.adopted.join(", ")}`));
  const counts = new Map<FileState, number>();
  for (const i of plan.items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  const summary = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
  console.log(chalk.dim(`    ${summary || "nothing to do"}`));
  for (const i of plan.items) {
    if (!verbose && !CONFLICTS.has(i.state)) continue;
    const label = CONFLICTS.has(i.state) ? chalk.yellow(i.state.padEnd(9)) : chalk.dim(i.state.padEnd(9));
    console.log(`    ${label} ${i.path}${i.note ? chalk.dim(`  (${i.note})`) : ""}`);
  }
}

/** Remove now-empty directories under an owned skill dir, deepest first (litter goes with them). */
function pruneEmptyDirs(dir: string): void {
  if (lkind(dir) !== "dir") return;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (lkind(abs) === "dir") pruneEmptyDirs(abs);
  }
  const left = readdirSync(dir);
  if (left.every((n) => LITTER.has(n) && lkind(join(dir, n)) === "file")) {
    for (const n of left) rmSync(join(dir, n), { force: true });
    rmdirSync(dir);
  }
}

function copyFileAtomic(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.wicked-tmp-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

/** Apply a conflict-free plan: write new/missing/changed files, prune unchanged obsolete ones, record. */
function applyDir(plan: DirPlan, manifest: PackManifest, origin: string, incoming: Incoming): void {
  const now = new Date().toISOString();
  const prior = plan.record;
  const base: PackRecord = {
    schema: RECORD_SCHEMA,
    pack: manifest.name,
    vendor: manifest.vendor,
    version: prior?.version ?? "(unrecorded)",
    source: prior?.source ?? origin,
    installId: prior?.installId ?? randomUUID(),
    installedAt: prior?.installedAt ?? now,
    configDir: plan.configDir,
    skillsRoot: plan.skillsRoot,
    skills: prior?.skills ?? [...plan.adopted],
    files: prior?.files ?? {},
  };
  if (!prior) {
    for (const i of plan.items) if (i.state === "unchanged" || i.state === "obsolete") base.files[i.path] = sha256File(fromKey(plan.skillsRoot, i.path));
  }
  // Journal first: until the final write, a retry accepts either the old or the new bytes.
  writeRecord(plan.recordFile, { ...base, pending: { version: manifest.version, skills: incoming.skills, files: incoming.files, startedAt: now } });

  // Prune first (every obsolete file was verified unchanged): a file that becomes a directory
  // (or the reverse), or a case-only rename on a case-insensitive filesystem, then lands cleanly.
  const touchedSkills = new Set<string>();
  for (const i of plan.items) {
    if (i.state !== "obsolete") continue;
    rmSync(fromKey(plan.skillsRoot, i.path), { force: true });
    touchedSkills.add(i.path.split("/")[0]);
  }
  for (const skill of touchedSkills) pruneEmptyDirs(join(plan.skillsRoot, skill));
  for (const [key, digest] of Object.entries(incoming.files)) {
    const dest = fromKey(plan.skillsRoot, key);
    if (lkind(dest) === "file" && sha256File(dest) === digest) continue;
    copyFileAtomic(incoming.sources[key], dest);
  }

  writeRecord(plan.recordFile, {
    ...base,
    version: manifest.version,
    source: origin,
    installedAt: now,
    skills: incoming.skills,
    files: incoming.files,
  });
}

function packConfigDirs(): string[] {
  return resolveClaudeConfigDirs().dirs;
}

/** The pack's canonical copy already installed (if any), read as a legacy ownership baseline. */
/** Written into the canonical copy by every recording install: its presence means "not a pre-record install". */
const RECORDED_STAMP = ".wicked-installer-recorded";

function legacyBaseline(name: string): { incoming: Incoming; version: string; plugin: boolean } | undefined {
  const dir = join(installedHome(), name);
  if (!existsSync(join(dir, MANIFEST))) return undefined;
  // Only a canonical copy left by a pre-record installer (≤ 0.8.1) that copied loose skills is
  // legacy ownership evidence: not one a recording install wrote (it left records where it
  // copied), and not a plugin-shaped pack (its skills were never copied).
  if (existsSync(join(dir, RECORDED_STAMP)) || existsSync(join(dir, ".claude-plugin", "plugin.json"))) return undefined;
  try {
    const manifest = readManifest(dir);
    return { incoming: readIncoming(dir, manifest), version: manifest.version, plugin: existsSync(join(dir, ".claude-plugin", "plugin.json")) };
  } catch {
    return undefined;
  }
}

export async function packAdd(source: string, flags: AddFlags): Promise<number> {
  let resolved: ResolvedSource;
  try {
    resolved = resolveSource(source, flags);
  } catch (err) {
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    const manifest = readManifest(resolved.dir);
    console.log(`${chalk.cyan("→")} pack ${chalk.bold(manifest.name)} v${manifest.version} (${resolved.origin})`);

    // 1. conformance gate — garden's shipped checker, fail-closed
    console.log(chalk.dim("  validating (wicked-garden pack check)..."));
    const checkStatus = gardenPack(["check", resolved.dir]);
    if (checkStatus !== 0 && !flags.force) {
      console.error(chalk.red("\npack failed the conformance gate — nothing installed (use --force to override)."));
      return 1;
    }
    if (checkStatus !== 0) {
      console.log(chalk.yellow("  conformance gate FAILED — continuing under --force."));
    }

    const isPlugin = existsSync(join(resolved.dir, ".claude-plugin", "plugin.json"));
    const dest = join(installedHome(), manifest.name);
    const configDirs = packConfigDirs();

    // 2. preflight — every destination classified before anything is written.
    let plans: DirPlan[] = [];
    let incoming: Incoming | undefined;
    if (!isPlugin) {
      incoming = readIncoming(resolved.dir, manifest);
      const legacy = legacyBaseline(manifest.name);
      plans = configDirs.map((dir) => classifyDir(dir, manifest.name, incoming!, legacy?.incoming));
      const held = plans.filter((p) => p.recordError || conflictsOf(p).length > 0);
      const from = plans.find((p) => p.record)?.record?.version ?? legacy?.version;
      console.log(chalk.dim(`  preflight (${from ? `installed ${from} → incoming ${manifest.version}` : `new install of ${manifest.version}`}):`));
      for (const p of plans) printPlan(p, flags.dryRun);
      if (incoming.skipped.length > 0) console.log(chalk.dim(`  not copied (links or special files in the pack): ${incoming.skipped.join(", ")}`));
      if (held.length > 0) {
        const what = `the ${from ? "update" : "install"} of ${manifest.name} ${from ? `${from} → ${manifest.version}` : manifest.version}`;
        console.error(chalk.yellow(
          `\nHELD${flags.dryRun ? " (dry-run)" : ""}: ${what} ${flags.dryRun ? "would be" : "is"} held — local edits or files this pack does not own are in the way (listed above).`,
        ));
        console.error(chalk.yellow(
          `Nothing was changed: the installed copy, its skills and its registration are as they were. ` +
          `Back up or move the listed paths (nothing is merged), then re-run \`wicked-installer pack add ${source}\`.`,
        ));
        return 1;
      }
    }

    if (flags.dryRun) {
      console.log(chalk.dim(`  [dry-run] would install to ${dest}`));
      if (isPlugin) console.log(chalk.dim("  [dry-run] pack ships as a Claude Code plugin — no skills would be copied"));
      else console.log(chalk.dim(`  [dry-run] would write skills to ${configDirs.map((d) => join(d, "skills")).join(", ")}: ${incoming!.skills.join(", ") || "(none)"}`));
      console.log(chalk.dim("  [dry-run] would register with wicked-garden"));
      return 0;
    }

    // 3. skill visibility for Claude Code (journaled per dir: an interrupted run retries cleanly)
    if (isPlugin) {
      console.log(chalk.dim("  pack ships as a Claude Code plugin — skills load via the plugin manager; skipping the skills copy."));
    } else {
      for (const p of plans) {
        applyDir(p, manifest, resolved.origin, incoming!);
        console.log(`  skills → ${p.skillsRoot}: ${incoming!.skills.join(", ") || "(none)"}`);
      }
    }

    // 4. canonical install home (publisher-managed, replaced whole) — only once every skills
    // dir holds the new version, so it never names a version the hosts are not serving.
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(installedHome(), { recursive: true });
    cpSync(resolved.dir, dest, { recursive: true });
    writeFileSync(join(dest, RECORDED_STAMP), `${JSON.stringify({ version: manifest.version, configDirs: isPlugin ? [] : configDirs })}\n`);
    console.log(`  installed to ${dest}`);

    // 5. registration — garden runtime catalog + crew routing + floors
    console.log(chalk.dim("  registering (wicked-garden pack register)..."));
    const regArgs = ["register", dest, "--source", resolved.origin];
    if (flags.force) regArgs.push("--force");
    const regStatus = gardenPack(regArgs);
    if (regStatus !== 0) {
      console.error(chalk.red(`registration failed — the pack files are installed and recorded, but the garden runtime will not route to them. Re-run \`wicked-installer pack add ${source}\` to retry (it converges: nothing is re-copied).`));
      return 1;
    }

    console.log(chalk.green(`\nDone. Verify with: npx wicked-garden pack list`));
    return 0;
  } catch (err) {
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (resolved.staging) rmSync(resolved.staging, { recursive: true, force: true });
  }
}

export async function packRemove(name: string): Promise<number> {
  try {
    assertSafeName(name);
  } catch (err) {
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    return 1;
  }
  const dest = join(installedHome(), name);
  // Only skills `pack add` created are candidates: a plugin-shaped pack never had its skills
  // copied, and deleting by name would remove unrelated user skills.
  const isPluginPack = existsSync(join(dest, ".claude-plugin", "plugin.json"));
  const legacy = isPluginPack ? undefined : legacyBaseline(name);
  const kept: string[] = [];
  let configDirs: string[];
  try {
    configDirs = packConfigDirs();
  } catch (err) {
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const configDir of configDirs) {
    const skillsRoot = join(configDir, "skills");
    const recordFile = recordFileFor(configDir, name);
    const { record, error } = readRecord(recordFile);
    if (error) {
      kept.push(`${skillsRoot} (record unreadable: ${error} — nothing there was removed)`);
      continue;
    }
    if (isPluginPack && !record) continue;
    const removed: string[] = [];
    if (!record) {
      // An install from before records: only in ~/.claude (where that installer wrote), only
      // whole skill dirs byte-identical to the pack's canonical copy, never one another pack claims.
      if (!legacy || !isLegacyDestination(configDir)) continue;
      const others = claimedByOthers(configDir, name);
      for (const skill of legacy.incoming.skills) {
        const skillDir = join(skillsRoot, skill);
        if (lkind(skillDir) === "absent") continue;
        const disk = lkind(skillDir) === "dir" ? treeDigests(skillsRoot, skill) : undefined;
        if (disk && !others.has(skill) && sameFiles(disk, filesOfSkill(legacy.incoming.files, skill))) {
          rmSync(skillDir, { recursive: true, force: true });
          removed.push(skill);
        } else {
          kept.push(`${skillDir} (not this pack's unmodified copy — left whole)`);
        }
      }
      if (removed.length > 0) console.log(`  removed from ${skillsRoot}: ${removed.join(", ")}`);
      continue;
    }
    const owned = ownedDigests(record);
    const ownedSkills = ownedSkillsOf(record);
    for (const skill of [...ownedSkills].sort()) {
      const skillDir = join(skillsRoot, skill);
      const dirKind = lkind(skillDir);
      if (dirKind === "absent") continue;
      if (dirKind !== "dir") {
        kept.push(`${skillDir} (not a directory)`);
        continue;
      }
      for (const [key, digests] of owned) {
        if (!key.startsWith(`${skill}/`)) continue;
        const abs = fromKey(skillsRoot, key);
        if (linkedBelow(skillsRoot, key)) {
          kept.push(`${abs} (a directory on its path is a link or a file — not followed)`);
          continue;
        }
        if (lkind(abs) !== "file") continue;
        if (digests.has(sha256File(abs))) rmSync(abs, { force: true });
        else kept.push(`${abs} (edited)`);
      }
      for (const f of walk(skillDir)) {
        const key = `${skill}/${f.rel}`;
        if (isLitter(key)) continue;
        kept.push(`${fromKey(skillsRoot, key)} (${owned.has(key) ? "edited" : "not written by this pack"})`);
      }
      pruneEmptyDirs(skillDir);
      if (lkind(skillDir) === "absent") removed.push(skill);
    }
    if (removed.length > 0) console.log(`  removed from ${skillsRoot}: ${removed.join(", ")}`);
    if (record) rmSync(recordFile, { force: true });
  }

  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    console.log(`  removed ${dest}`);
  }
  const unregistered = gardenPack(["unregister", name]);
  const keptPaths = [...new Set(kept)];
  if (keptPaths.length > 0) {
    console.error(chalk.yellow(`\nCleanup INCOMPLETE for ${name}: kept ${keptPaths.length} path(s) that were edited or not written by this pack:`));
    for (const k of keptPaths) console.error(chalk.yellow(`  ${k}`));
    console.error(chalk.yellow(`The pack is ${unregistered === 0 ? "unregistered" : "NOT unregistered (see above)"} and its installed copy is removed; back up or delete the kept paths yourself.`));
    return 1;
  }
  return unregistered;
}

export function printPackHelp(): void {
  console.log([
    "Usage: wicked-installer pack <verb>",
    "",
    "  pack add <dir|npm-spec> [flags]   Acquire, validate, install, and register a skill pack",
    "      --source-url <url>            Provenance origin recorded at registration",
    "      --dry-run                     Show the plan, write nothing",
    "      --force                       Install even if the conformance gate fails",
    "  pack remove <name>                Unregister + remove an installed pack (edited files are kept and reported)",
    "",
    "A local edit to an installed pack skill, or a same-named skill this pack does not own,",
    "HOLDS the pack's update before anything changes; the paths are listed, nothing is merged.",
    "  pack list [--json]                Show what the garden runtime discovers (delegates)",
    "  pack check <dir> [--json]         Conformance-check a pack (delegates)",
    "",
    "Validation + registration are wicked-garden's (`npx wicked-garden pack …`);",
    "this command is the acquisition/staging path both garden and third parties use.",
    "Pack authoring guide: wicked-garden docs/extending.md",
  ].join("\n"));
}

/** Split pack argv into positionals + flags (flag values never leak into
 *  positionals). A missing/flag-like `--source-url` value is a parse error —
 *  silently swallowing the next flag would corrupt both flags AND provenance. */
export function parsePackArgs(argv: string[]): { positionals: string[]; flags: AddFlags; error?: string } {
  const positionals: string[] = [];
  const flags: AddFlags = { dryRun: false, force: false };
  let error: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--source-url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        error = "--source-url requires a URL value";
      } else {
        flags.sourceUrl = value;
        i += 1;
      }
    }
    else positionals.push(arg);
  }
  return { positionals, flags, error };
}

export async function runPack(argv: string[]): Promise<number> {
  const { positionals, flags, error } = parsePackArgs(argv);
  if (error) {
    console.error(chalk.red(`Error: ${error}`));
    return 1;
  }
  const verb = positionals[0];
  const rest = positionals.slice(1);

  switch (verb) {
    case "add":
      if (!rest[0]) {
        console.error(chalk.red("Specify a pack source: a local directory or an npm package spec."));
        return 1;
      }
      return packAdd(rest[0], flags);
    case "remove":
      if (!rest[0]) {
        console.error(chalk.red("Specify the pack name to remove."));
        return 1;
      }
      return packRemove(rest[0]);
    case "list":
      return gardenPack(["list", ...rest]);
    case "check":
      return gardenPack(["check", ...rest]);
    default:
      printPackHelp();
      return verb ? 1 : 0;
  }
}
