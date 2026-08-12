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
 *      Code plugins get their skills copied into ~/.claude/skills/<skill>/
 *      (other CLIs: the per-CLI install-script seam, INTERFACE.md — not
 *      wired for packs yet, stated honestly in the README);
 *   5. register with garden (`wicked-garden pack register <dir> --source …`)
 *      so the runtime catalog, crew routing, and peer-floor probe see it.
 *
 * `pack remove <name>` reverses 3-5. `pack list` / `pack check` delegate.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";

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

function claudeSkillsHome(): string {
  return join(homedir(), ".claude", "skills");
}

// ---------------------------------------------------------------------------
// Spawn helpers (Windows npm/npx rule: .cmd shims need shell: true)
// ---------------------------------------------------------------------------

function isCmdShim(cmd: string): boolean {
  return process.platform === "win32" && /^(npm|npx)$/i.test(cmd);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number; out: string } {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isCmdShim(cmd),
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? 1, out };
}

/** Run and stream output straight through (for user-facing delegated verbs). */
function runThrough(cmd: string, args: string[]): number {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: isCmdShim(cmd) });
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

  // npm spec
  const staging = mkdtempSync(join(tmpdir(), "wicked-pack-"));
  console.log(chalk.dim(`  fetching ${source} from npm...`));
  const res = run("npm", ["install", "--prefix", staging, "--no-fund", "--no-audit", "--loglevel=error", source]);
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

function readManifest(dir: string): PackManifest {
  const parsed = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as PackManifest;
  if (!parsed.name) throw new Error(`${MANIFEST} has no "name"`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Install steps
// ---------------------------------------------------------------------------

function copySkillsToClaude(packDir: string, manifest: PackManifest, dryRun: boolean): string[] {
  const skillsDir = join(packDir, manifest.skills_dir ?? "skills");
  if (!existsSync(skillsDir)) return [];
  const copied: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(skillsDir, entry.name, "SKILL.md"))) continue;
    const dest = join(claudeSkillsHome(), entry.name);
    if (!dryRun) {
      mkdirSync(claudeSkillsHome(), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(skillsDir, entry.name), dest, { recursive: true });
    }
    copied.push(entry.name);
  }
  return copied;
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

    if (flags.dryRun) {
      console.log(chalk.dim(`  [dry-run] would install to ${join(installedHome(), manifest.name)}`));
      const wouldCopy = copySkillsToClaude(resolved.dir, manifest, true);
      console.log(chalk.dim(`  [dry-run] would copy skills to ~/.claude/skills: ${wouldCopy.join(", ") || "(none)"}`));
      console.log(chalk.dim("  [dry-run] would register with wicked-garden"));
      return 0;
    }

    // 2. canonical install home
    const dest = join(installedHome(), manifest.name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(installedHome(), { recursive: true });
    cpSync(resolved.dir, dest, { recursive: true });
    console.log(`  installed to ${dest}`);

    // 3. skill visibility for Claude Code
    if (existsSync(join(dest, ".claude-plugin", "plugin.json"))) {
      console.log(chalk.dim("  pack ships as a Claude Code plugin — skills load via the plugin manager; skipping ~/.claude/skills copy."));
    } else {
      const copied = copySkillsToClaude(dest, manifest, false);
      console.log(`  skills → ~/.claude/skills: ${copied.join(", ") || "(none)"}`);
    }

    // 4. registration — garden runtime catalog + crew routing + floors
    console.log(chalk.dim("  registering (wicked-garden pack register)..."));
    const regArgs = ["register", dest, "--source", resolved.origin];
    if (flags.force) regArgs.push("--force");
    const regStatus = gardenPack(regArgs);
    if (regStatus !== 0) {
      console.error(chalk.red("registration failed — pack files are installed but the garden runtime will not route to them."));
      return 1;
    }

    console.log(chalk.green(`\nDone. Verify with: npx wicked-garden pack list`));
    return 0;
  } finally {
    if (resolved.staging) rmSync(resolved.staging, { recursive: true, force: true });
  }
}

export async function packRemove(name: string): Promise<number> {
  const dest = join(installedHome(), name);
  let skills: string[] = [];
  if (existsSync(join(dest, MANIFEST))) {
    try {
      const manifest = readManifest(dest);
      const skillsDir = join(dest, manifest.skills_dir ?? "skills");
      if (existsSync(skillsDir)) {
        skills = readdirSync(skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
          .map((e) => e.name);
      }
    } catch {
      /* manifest unreadable — still unregister + remove the dir */
    }
  }

  for (const skill of skills) {
    rmSync(join(claudeSkillsHome(), skill), { recursive: true, force: true });
  }
  if (skills.length > 0) console.log(`  removed from ~/.claude/skills: ${skills.join(", ")}`);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    console.log(`  removed ${dest}`);
  }
  return gardenPack(["unregister", name]);
}

export function printPackHelp(): void {
  console.log([
    "Usage: wicked-installer pack <verb>",
    "",
    "  pack add <dir|npm-spec> [flags]   Acquire, validate, install, and register a skill pack",
    "      --source-url <url>            Provenance origin recorded at registration",
    "      --dry-run                     Show the plan, write nothing",
    "      --force                       Install even if the conformance gate fails",
    "  pack remove <name>                Unregister + remove an installed pack",
    "  pack list [--json]                Show what the garden runtime discovers (delegates)",
    "  pack check <dir> [--json]         Conformance-check a pack (delegates)",
    "",
    "Validation + registration are wicked-garden's (`npx wicked-garden pack …`);",
    "this command is the acquisition/staging path both garden and third parties use.",
    "Pack authoring guide: wicked-garden docs/extending.md",
  ].join("\n"));
}

/** Split pack argv into positionals + flags (flag values never leak into positionals). */
export function parsePackArgs(argv: string[]): { positionals: string[]; flags: AddFlags } {
  const positionals: string[] = [];
  const flags: AddFlags = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--source-url") { flags.sourceUrl = argv[i + 1]; i += 1; }
    else positionals.push(arg);
  }
  return { positionals, flags };
}

export async function runPack(argv: string[]): Promise<number> {
  const { positionals, flags } = parsePackArgs(argv);
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
