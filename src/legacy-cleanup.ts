// `wicked-installer cleanup-legacy` — remove the legacy, unregistered copies of a Claude Code
// plugin (wicked-garden) that earlier installers left behind, ONLY where ownership is proven
// (INTERFACE.md §12.6, issue #20).
//
// A marker-driven removal is a deletion driven by data on disk, so the bar is: every entry is
// validated before anything is touched (positive ownership allow-list, relative paths only, every
// component lstat'd — no symlink anywhere below the config dir — and realpath-contained in it);
// the plugin registration for that dir is re-derived from disk as `registered` first; one refused
// entry means NOTHING is removed in that dir, its marker record is kept and the run fails. Opt-in
// by design: `install` only reports legacy copies and names this verb.

import { copyFileSync, constants as fsConstants, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { claudePluginSpec, describeVerdict, isSafeSegment, isUnder, readRegistration, registrationVerdict, resolveClaudeConfigDirs, type ClaudePluginSpec } from "./claude-plugin.js";
import { listProducts } from "./registry.js";

export type RemovalKind = "bare-copy" | "dir" | "file" | "json-key" | "hooks-entry" | "marker-entry";
export type RemovalResult = "removed" | "planned" | "absent" | "kept" | "refused" | "failed";
export type DirResult = "cleaned" | "planned" | "nothing" | "blocked" | "failed";

export interface Removal { kind: RemovalKind; target: string; result: RemovalResult; detail: string }
export interface DirReport { configDir: string; productId: string; registration: string; result: DirResult; removals: Removal[] }
export interface CleanupEnvelope { verb: "cleanup-legacy"; dryRun: boolean; dirs: DirReport[] }

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function errCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A marker path as segments: relative, no empty/./.. segment, no drive, no `~`, no control chars. */
function relSegments(value: unknown): string[] | string {
  if (typeof value !== "string" || value === "") return "not a non-empty string";
  if (CONTROL.test(value)) return "contains control characters";
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.startsWith("~")) return "not a path relative to the config dir";
  const segs = value.split(/[\\/]/);
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "has an empty, `.` or `..` segment";
  return segs;
}

type Walk = { state: "absent" } | { state: "present"; kind: "dir" | "file" | "other"; abs: string } | { state: "refused"; why: string };

/** lstat every component below `root` (no symlink anywhere), then realpath-contain the leaf in `rootReal`. */
function walk(root: string, rootReal: string, segs: string[]): Walk {
  let cur = root;
  for (let i = 0; i < segs.length; i += 1) {
    cur = join(cur, segs[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (errCode(err) === "ENOENT") return { state: "absent" };
      return { state: "refused", why: `${cur}: ${errCode(err)}` };
    }
    if (st.isSymbolicLink()) return { state: "refused", why: `${cur}: is a symlink — refusing to follow it` };
    if (i < segs.length - 1 && !st.isDirectory()) return { state: "refused", why: `${cur}: not a directory` };
    if (i === segs.length - 1) {
      try {
        const real = realpathSync(cur);
        if (real === rootReal || !isUnder(real, rootReal)) return { state: "refused", why: `${cur}: resolves outside ${root}` };
      } catch (err) {
        return { state: "refused", why: `${cur}: ${errCode(err)}` };
      }
      return { state: "present", kind: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other", abs: cur };
    }
  }
  return { state: "absent" };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}
// The same hash install-claude.js records as `wroteHash`.
const hashValue = (v: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(v))).digest("hex")}`;

/** A planned edit to one config file (json-key / hooks-entry), applied after every check passed. */
interface ConfigEdit { file: "settings.json" | ".claude.json"; apply: (obj: Record<string, unknown>) => void }

interface Planned { removal: Removal; abs?: string; segs?: string[]; want?: "dir" | "file" | "other"; edit?: ConfigEdit }

function readConfig(root: string, rootReal: string, file: string): { obj?: Record<string, unknown>; absent?: true; why?: string } {
  const w = walk(root, rootReal, [file]);
  if (w.state === "absent") return { absent: true };
  if (w.state === "refused") return { why: w.why };
  if (w.kind !== "file") return { why: `${w.abs}: not a regular file` };
  try {
    const v = JSON.parse(readFileSync(w.abs, "utf8")) as unknown;
    return isRecord(v) ? { obj: v } : { why: `${w.abs}: not a JSON object` };
  } catch {
    return { why: `${w.abs}: corrupt JSON — fix or remove it, then re-run` };
  }
}

/** Validate one v2 marker record against the positive-ownership allow-list. */
function planRecord(rec: unknown, root: string, rootReal: string, spec: ClaudePluginSpec): Planned {
  const id = spec.productId;
  const refuse = (kind: RemovalKind, target: string, why: string): Planned => ({ removal: { kind, target, result: "refused", detail: why } });
  if (!isRecord(rec)) return refuse("file", "?", "marker record is not an object");
  const kind = rec.kind;
  if (kind === "dir" || kind === "file") {
    const target = typeof rec.path === "string" ? rec.path : JSON.stringify(rec.path);
    const segs = relSegments(rec.path);
    if (typeof segs === "string") return refuse(kind, target, `path ${segs}`);
    const skill = segs.length === 2 && segs[0] === "skills" && isSafeSegment(segs[1]) && segs[1].startsWith(id);
    const payload = segs.length >= 3 && segs[0] === "wicked-installer" && segs[1] === "products" && segs[2] === id && segs.every(isSafeSegment);
    if (!skill && !payload) return refuse(kind, target, `not on the ownership allow-list (skills/${id}*, wicked-installer/products/${id}/)`);
    const w = walk(root, rootReal, segs);
    if (w.state === "refused") return refuse(kind, target, w.why);
    if (w.state === "absent") return { removal: { kind, target, result: "absent", detail: "already gone" } };
    if (skill) {
      if (w.kind !== "dir") return refuse(kind, target, "a recorded skill is not a directory");
      const sk = walk(root, rootReal, [...segs, "SKILL.md"]);
      if (sk.state !== "present" || sk.kind !== "file") return refuse(kind, target, sk.state === "refused" ? sk.why : "no SKILL.md regular file — cannot prove ownership");
      let body = "";
      try { body = readFileSync(sk.abs, "utf8"); } catch (err) { return refuse(kind, target, `SKILL.md: ${errCode(err)}`); }
      if (!body.includes(id)) return refuse(kind, target, `SKILL.md does not carry the ${id} signature`);
    } else if (w.kind === "other") {
      return refuse(kind, target, "not a regular file or directory");
    }
    return { removal: { kind, target, result: "planned", detail: w.kind === "dir" ? "directory" : "file" }, abs: w.abs, segs, want: w.kind };
  }
  if (kind === "json-key") {
    const pointer = typeof rec.pointer === "string" ? rec.pointer : "";
    const target = `${String(rec.file)}${pointer}`;
    if (rec.file !== ".claude.json") return refuse(kind, target, `config file ${JSON.stringify(rec.file)} is not this config dir's .claude.json — a cleanup never touches a file outside the dir; remove ${pointer || "the entry"} by hand`);
    const m = /^\/mcpServers\/([^/]+)$/.exec(pointer);
    if (!m || CONTROL.test(pointer)) return refuse(kind, target, "pointer is not /mcpServers/<name>");
    const name = m[1].replace(/~1/g, "/").replace(/~0/g, "~");
    if (name.includes("/") || name === "") return refuse(kind, target, "pointer names no single server key");
    if (typeof rec.wroteHash !== "string" || rec.wroteHash === "") return refuse(kind, target, "no wroteHash — cannot prove the value is ours");
    const cfg = readConfig(root, rootReal, ".claude.json");
    if (cfg.why) return refuse(kind, target, cfg.why);
    const servers = cfg.obj && isRecord(cfg.obj.mcpServers) ? cfg.obj.mcpServers : undefined;
    const cur = servers ? servers[name] : undefined;
    if (cur === undefined) return { removal: { kind, target, result: "absent", detail: "already gone" } };
    if (hashValue(cur) !== rec.wroteHash) return refuse(kind, target, "changed since the installer wrote it — remove it by hand");
    const prior = rec.prior;
    return {
      removal: { kind, target, result: "planned", detail: prior !== undefined && prior !== null ? "restore the prior value" : "delete" },
      edit: {
        file: ".claude.json",
        apply: (obj) => {
          const map = isRecord(obj.mcpServers) ? obj.mcpServers : {};
          // Re-proven on the bytes about to be rewritten, not on the planning read.
          if (map[name] !== undefined && hashValue(map[name]) !== rec.wroteHash) throw new Error(`.claude.json${pointer} changed during the cleanup`);
          if (prior !== undefined && prior !== null) map[name] = prior;
          else delete map[name];
          obj.mcpServers = map;
        },
      },
    };
  }
  if (kind === "hooks-entry") {
    const event = typeof rec.event === "string" ? rec.event : "";
    const target = `${String(rec.file)}#${event}`;
    if (rec.file !== "settings.json") return refuse(kind, target, `hooks file ${JSON.stringify(rec.file)} is not this config dir's settings.json`);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(event)) return refuse(kind, target, "event is not a well-formed hook event name");
    const owner = isRecord(rec.ownerMatch) && typeof rec.ownerMatch.commandContains === "string" ? rec.ownerMatch.commandContains.replace(/\\/g, "/") : "";
    const ownKey = `wicked-installer/products/${id}`;
    if (!owner.includes(ownKey)) return refuse(kind, target, `owner selector is not the product's own key (${ownKey})`);
    const cfg = readConfig(root, rootReal, "settings.json");
    if (cfg.why) return refuse(kind, target, cfg.why);
    const ours = (g: unknown): boolean => { try { return (JSON.stringify(g) ?? "").replace(/\\\\/g, "/").includes(ownKey); } catch { return false; } };
    const hooks = cfg.obj && isRecord(cfg.obj.hooks) ? cfg.obj.hooks : undefined;
    const arr = hooks && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (!arr.some(ours)) return { removal: { kind, target, result: "absent", detail: "no hook group of ours under this event" } };
    return {
      removal: { kind, target, result: "planned", detail: `remove ${arr.filter(ours).length} hook group(s)` },
      edit: {
        file: "settings.json",
        apply: (obj) => {
          const h = isRecord(obj.hooks) ? obj.hooks : {};
          const kept = Array.isArray(h[event]) ? (h[event] as unknown[]).filter((g) => !ours(g)) : [];
          if (kept.length) h[event] = kept;
          else delete h[event];
          obj.hooks = h;
        },
      },
    };
  }
  return refuse("file", JSON.stringify(kind), `unknown record kind ${JSON.stringify(kind)}`);
}

function atomicWrite(file: string, data: unknown): void {
  const tmp = join(dirname(file), `.${Date.now()}.wicked-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

function backup(root: string, rootReal: string, abs: string, base: string): void {
  const dir = walk(root, rootReal, ["wicked-installer", "backups"]);
  if (dir.state === "refused") throw new Error(`backup refused: ${dir.why}`);
  if (dir.state === "present" && dir.kind !== "dir") throw new Error("backup refused: wicked-installer/backups is not a directory");
  const backups = join(root, "wicked-installer", "backups");
  if (dir.state === "absent") mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  copyFileSync(abs, join(backups, `${base}.${stamp}.${randomBytes(3).toString("hex")}.bak`), fsConstants.COPYFILE_EXCL);
}

/** Plan (and unless dry-run, perform) the cleanup of one plugin in one config dir. */
export function cleanupDir(configDir: string, spec: ClaudePluginSpec, dryRun: boolean): DirReport {
  const root = configDir;
  const report: DirReport = { configDir, productId: spec.productId, registration: "unknown", result: "nothing", removals: [] };
  let rootReal: string;
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      report.result = "failed";
      report.removals.push({ kind: "dir", target: root, result: "refused", detail: "the config dir is a symlink or not a directory" });
      return report;
    }
    rootReal = realpathSync(root);
  } catch (err) {
    if (errCode(err) === "ENOENT") { report.registration = "absent"; return report; }
    report.result = "failed";
    report.removals.push({ kind: "dir", target: root, result: "refused", detail: `${root}: ${errCode(err)}` });
    return report;
  }

  const verdict = registrationVerdict(readRegistration(root, spec));
  report.registration = describeVerdict(verdict);
  const planned: Planned[] = [];

  // 1. The bare plugins/<plugin>/ copy: a real dir holding a plugin.json that names the plugin.
  const bare = walk(root, rootReal, ["plugins", spec.pluginName]);
  if (bare.state === "refused") planned.push({ removal: { kind: "bare-copy", target: join(root, "plugins", spec.pluginName), result: "refused", detail: bare.why } });
  else if (bare.state === "present") {
    const target = bare.abs;
    const man = walk(root, rootReal, ["plugins", spec.pluginName, ".claude-plugin", "plugin.json"]);
    let why: string | undefined;
    if (bare.kind !== "dir") why = "not a directory";
    else if (man.state === "refused") why = man.why;
    else if (man.state !== "present" || man.kind !== "file") why = "no .claude-plugin/plugin.json regular file — cannot prove ownership";
    else {
      try {
        const m = JSON.parse(readFileSync(man.abs, "utf8")) as unknown;
        if (!isRecord(m) || m.name !== spec.pluginName) why = `plugin.json does not name ${spec.pluginName}`;
      } catch {
        why = "plugin.json is corrupt JSON";
      }
    }
    planned.push(why ? { removal: { kind: "bare-copy", target, result: "refused", detail: why } } : { removal: { kind: "bare-copy", target, result: "planned", detail: "unregistered bare copy" }, abs: target, segs: ["plugins", spec.pluginName], want: "dir" });
  }

  // 2. The install-claude.js marker record for the plugin: every file record validated.
  const markerSegs = ["wicked-installer", "claude-install.json"];
  const markerTarget = join(root, ...markerSegs);
  const mw = walk(root, rootReal, markerSegs);
  let marker: Record<string, unknown> | undefined;
  let rewriteMarker: (() => void) | undefined;
  if (mw.state === "refused") planned.push({ removal: { kind: "marker-entry", target: markerTarget, result: "refused", detail: mw.why } });
  else if (mw.state === "present") {
    try {
      const v = JSON.parse(readFileSync(mw.abs, "utf8")) as unknown;
      if (!isRecord(v)) throw new Error("not an object");
      marker = v;
    } catch (err) {
      planned.push({ removal: { kind: "marker-entry", target: markerTarget, result: "refused", detail: `install marker is unreadable (${err instanceof Error ? err.message : String(err)})` } });
    }
  }
  if (marker) {
    const products = marker.products;
    const id = spec.productId;
    if (isRecord(products) && marker.markerVersion === 2 && id in products) {
      const entry = products[id];
      if (!isRecord(entry) || !Array.isArray(entry.files)) {
        planned.push({ removal: { kind: "marker-entry", target: `${markerTarget}#${id}`, result: "refused", detail: "marker record is malformed" } });
      } else if (entry.files.length === 0) {
        planned.push({ removal: { kind: "marker-entry", target: `${markerTarget}#${id}`, result: "refused", detail: "the record has no file manifest (carried forward from a v1 marker) — ownership of the copies cannot be proven; remove them by hand, then delete this record" } });
      } else {
        for (const rec of entry.files) planned.push(planRecord(rec, root, rootReal, spec));
        planned.push({ removal: { kind: "marker-entry", target: `${markerTarget}#${id}`, result: "planned", detail: "drop the record once every removal succeeded" } });
        rewriteMarker = () => {
          delete products[id];
          if (Object.keys(products).length === 0) {
            const again = walk(root, rootReal, markerSegs);
            if (again.state === "refused") throw new Error(again.why);
            if (again.state === "present") {
              if (again.kind !== "file") throw new Error(`${again.abs}: changed type since it was validated`);
              rmSync(again.abs);
            }
          }
          else {
            marker!.updatedAt = new Date().toISOString();
            atomicWrite(markerTarget, marker);
          }
        };
      }
    } else if (Array.isArray(products) && products.some((p) => isRecord(p) && p.id === id)) {
      planned.push({ removal: { kind: "marker-entry", target: `${markerTarget}#${id}`, result: "refused", detail: "v1 marker entry — no file manifest, ownership cannot be proven; remove the copies by hand" } });
    }
  }

  report.removals = planned.map((p) => p.removal);
  const actionable = planned.filter((p) => p.removal.result === "planned" && p.removal.kind !== "marker-entry");
  const anyRefused = planned.some((p) => p.removal.result === "refused");
  if (planned.length === 0) return report; // nothing legacy here

  if (verdict.state !== "registered" && !anyRefused) {
    report.result = "blocked";
    for (const p of planned) {
      if (p.removal.result === "planned") { p.removal.result = "kept"; p.removal.detail = `registration is ${report.registration} — nothing is removed until it is registered (install wicked-garden first)`; }
    }
    return report;
  }
  if (anyRefused) {
    report.result = "failed";
    for (const p of planned) {
      if (p.removal.result === "planned") { p.removal.result = "kept"; p.removal.detail = `another entry was refused — nothing in this config dir was removed and the marker record is kept${verdict.state !== "registered" ? ` (registration is also ${report.registration})` : ""}`; }
    }
    return report;
  }
  if (actionable.length === 0 && !rewriteMarker) return report;
  if (dryRun) { report.result = "planned"; return report; }

  // Execute: config edits (one backup + atomic write per file), then paths, then the marker.
  try {
    for (const file of [".claude.json", "settings.json"] as const) {
      const edits = planned.filter((p) => p.removal.result === "planned" && p.edit?.file === file);
      if (edits.length === 0) continue;
      const cfg = readConfig(root, rootReal, file);
      if (!cfg.obj) throw new Error(cfg.why ?? `${file} vanished`);
      for (const p of edits) p.edit!.apply(cfg.obj);
      const abs = join(root, file);
      backup(root, rootReal, abs, file);
      atomicWrite(abs, cfg.obj);
      for (const p of edits) { p.removal.result = "removed"; }
    }
    for (const p of planned) {
      if (p.removal.result !== "planned" || !p.abs || !p.segs) continue;
      // Re-walked immediately before the removal: a component swapped for a link since planning is refused.
      const again = walk(root, rootReal, p.segs);
      if (again.state === "absent") { p.removal.result = "absent"; continue; }
      if (again.state === "refused") throw new Error(again.why);
      if (again.kind !== p.want) throw new Error(`${again.abs}: changed type since it was validated`);
      rmSync(p.abs, { recursive: true });
      p.removal.result = "removed";
    }
    if (rewriteMarker) {
      rewriteMarker();
      const m = planned.find((p) => p.removal.kind === "marker-entry" && p.removal.result === "planned");
      if (m) m.removal.result = "removed";
    }
    report.result = "cleaned";
  } catch (err) {
    report.result = "failed";
    const next = planned.find((p) => p.removal.result === "planned");
    const detail = `failed: ${err instanceof Error ? err.message : String(err)} — the marker record is kept; re-run after fixing`;
    if (next) { next.removal.result = "failed"; next.removal.detail = detail; }
    else report.removals.push({ kind: "marker-entry", target: markerTarget, result: "failed", detail });
  }
  return report;
}

export function printCleanupHelp(): void {
  console.log([
    "wicked-installer cleanup-legacy — remove legacy, unregistered wicked-garden copies where ownership is proven",
    "",
    "Usage:",
    "  wicked-installer cleanup-legacy [--claude-home <dir>]... [--dry-run] [--json]",
    "",
    "Removes, per Claude config dir (default: $CLAUDE_CONFIG_DIR, else ~/.claude), only after the plugin",
    "registration there is `registered`: the bare plugins/wicked-garden copy, and the skills/hooks/MCP entries",
    "an earlier install-claude.js recorded for it. Every entry is validated first; one refusal removes nothing",
    "in that dir, keeps the marker record and exits 1. Nothing outside the config dir is touched.",
  ].join("\n"));
}

export async function runCleanupLegacy(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { printCleanupHelp(); return 0; }
  const homes: string[] = [];
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--claude-home" || arg.startsWith("--claude-home=")) {
      const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!v) { console.error(chalk.red("Error: --claude-home requires a directory")); return 2; }
      homes.push(v);
    } else { console.error(chalk.red(`Error: unknown argument: ${arg}`)); return 2; }
  }
  let dirs: string[];
  try {
    dirs = resolveClaudeConfigDirs({ homeFlags: homes }).dirs;
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    return 2;
  }
  const specs = listProducts(true).filter((p) => p.type === "claude-plugin").map((p) => claudePluginSpec(p));
  const reports: DirReport[] = [];
  for (const dir of dirs) for (const spec of specs) reports.push(cleanupDir(dir, spec, dryRun));
  const envelope: CleanupEnvelope = { verb: "cleanup-legacy", dryRun, dirs: reports };
  if (json) console.log(JSON.stringify(envelope, null, 2));
  else {
    for (const r of reports) {
      const color = r.result === "failed" || r.result === "blocked" ? chalk.red : r.result === "nothing" ? chalk.dim : chalk.green;
      console.log(`${color(`[${r.result}]`)} ${r.productId} in ${r.configDir} (registration: ${r.registration})`);
      for (const m of r.removals) console.log(chalk.dim(`  ${m.result.padEnd(8)} ${m.kind.padEnd(12)} ${m.target}${m.detail ? ` — ${m.detail}` : ""}`));
    }
  }
  return reports.some((r) => r.result === "failed" || r.result === "blocked") ? 1 : 0;
}
