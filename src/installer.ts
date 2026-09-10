import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execa } from "execa";
import type { Product, InstallResult } from "./types.js";
import { LEGACY_CLEANUP_ISSUE, claudePluginSpec, detectLegacyCopies, planClaudePlugin, registerClaudePlugin, resolveClaudeConfigDirs, resolveMarketplaceSource } from "./claude-plugin.js";

const SKIP_BINARY_EXTS = /\.(md|txt|sha256|sha512|asc|json|toml|yaml|yml|xml|html|css|js|ts)$/i;

export interface InstallOptions {
  /** Print the exact plan and run NOTHING that writes — no spawns, no downloads, no copies. */
  dryRun?: boolean;
  /** Local checkout root: `<root>/wicked-garden` is registered as the marketplace instead of GitHub. */
  sourceRoot?: string;
  /** Explicit Claude config dir(s) (`--claude-home`); otherwise CLAUDE_CONFIG_DIR, then ~/.claude. */
  claudeHomes?: string[];
  /**
   * Claude Code was chosen as the TARGET (the interactive Claude path): when no `claude` CLI
   * resolves, report a manual step and copy nothing instead of the bare-copy fallback — a copy
   * Claude Code never loads is not an install of the thing the user selected.
   */
  noFallback?: boolean;
  /**
   * Legacy copies the caller already detected and reported (the picker does so BEFORE the Claude
   * script runs, since that script's marker upgrade would otherwise hide a v1 entry). When given,
   * detection and the per-path log lines are skipped; the count still goes into the result message.
   */
  preDetectedLegacy?: string[];
  /** Sink for progress and `dry-run:` plan lines (default: console.log). */
  log?: (line: string) => void;
}

/**
 * Resolve every Claude config directory that should receive dropped-in files.
 * Honors CLAUDE_CONFIG_DIR (Claude Code's override, which may list multiple
 * paths separated by ":" or ",") and always includes the default ~/.claude,
 * so tooling lands in both the alt config and the default. De-duplicated.
 */
function configDirs(): string[] {
  const dirs = [join(homedir(), ".claude")];
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) {
    for (const p of override.split(/[:,]/).map((s) => s.trim()).filter(Boolean)) {
      dirs.push(p);
    }
  }
  return [...new Set(dirs)];
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

type Planner = (lines: string[], summary: string) => InstallResult;

export async function installProduct(product: Product, options: InstallOptions = {}): Promise<InstallResult> {
  const { id, displayName, install } = product;
  const dryRun = options.dryRun === true;
  const log = options.log ?? ((line: string) => console.log(line));

  // Every dry-run exit goes through here: the plan is printed, nothing that writes runs, and
  // the result is marked `planned` so callers can tell "would do" from "did". `probe:` lines
  // are what the plan was derived from; `dry-run:` lines are what a live run would execute.
  const plan: Planner = (lines, summary) => {
    for (const line of lines) log(line.startsWith("probe:") ? `  ${line}` : `  dry-run: ${line}`);
    return { productId: id, success: true, skipped: false, planned: true, message: `${displayName}: dry-run — ${summary}` };
  };

  try {
    // A Claude Code plugin is REGISTERED through Claude Code's own CLI (claude-plugin.ts);
    // its `install` block is only the fallback for a machine without Claude Code.
    if (product.type === "claude-plugin") return await installClaudePlugin(product, options, plan, log);

    switch (install.type) {
      case "npm-global": {
        if (!install.package) throw new Error("install.package required for npm-global");
        const args = ["install", "-g", install.package];
        if (dryRun) return plan([`npm ${args.join(" ")}`], `would run npm ${args.join(" ")}`);
        await execa("npm", args, { stdio: "inherit" });
        return { productId: id, success: true, skipped: false, message: `${displayName} installed globally via npm` };
      }

      case "npm-run": {
        if (!install.package) throw new Error("install.package required for npm-run");
        const cmd = install.command ?? "install";
        const args = [install.package, cmd, ...(install.args ?? [])];
        if (dryRun) return plan([`npx ${args.join(" ")}`], `would run npx ${args.join(" ")}`);
        await execa("npx", args, { stdio: "inherit" });
        return { productId: id, success: true, skipped: false, message: `${displayName} installed via npx ${install.package} ${cmd}` };
      }

      case "manual": {
        const message = install.instructions ?? `${displayName} requires manual installation.`;
        if (dryRun) return { ...plan([`manual step, nothing to run: ${message}`], `manual step — ${message}`), skipped: true };
        return { productId: id, success: true, skipped: true, message };
      }

      case "binary": {
        const message = install.instructions ?? `${displayName} requires binary download.`;
        if (dryRun) return { ...plan([`manual step, nothing to run: ${message}`], `manual step — ${message}`), skipped: true };
        return { productId: id, success: true, skipped: true, message };
      }

      case "github-binary": {
        if (!install.githubRepo) throw new Error("install.githubRepo required for github-binary");

        const platform = process.platform;
        const arch = process.arch;
        const osName: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
        const archName: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
        const os = osName[platform] ?? platform;
        const cpu = archName[arch] ?? arch;
        const binDir = join(homedir(), ".local", "bin");
        const dest = join(binDir, id);

        if (dryRun) {
          return plan(
            [
              `GET https://api.github.com/repos/${install.githubRepo}/releases/latest`,
              `download the ${os}-${cpu} asset${install.assetPattern ? ` matching /${install.assetPattern}/` : ""}`,
              `extract/copy the binary to ${dest}`,
            ],
            `would download the latest ${install.githubRepo} ${os}-${cpu} release to ${dest}`,
          );
        }

        const relRes = await fetch(`https://api.github.com/repos/${install.githubRepo}/releases/latest`);
        if (!relRes.ok) throw new Error(`GitHub API error: ${relRes.status}`);
        const release = await relRes.json() as { assets: Array<{ name: string; browser_download_url: string }> };

        const pattern = install.assetPattern
          ? new RegExp(install.assetPattern)
          : new RegExp(`${os}.*${cpu}|${cpu}.*${os}`, "i");

        const asset = release.assets.find(a => pattern.test(a.name) && !a.name.endsWith(".sha256"));
        if (!asset) {
          return {
            productId: id, success: false, skipped: false,
            message: `No ${os}-${cpu} binary found in latest ${install.githubRepo} release`,
          };
        }

        mkdirSync(binDir, { recursive: true });

        const dlRes = await fetch(asset.browser_download_url);
        if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
        const data = Buffer.from(await dlRes.arrayBuffer());

        const isArchive = /\.(tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$/i.test(asset.name);
        if (isArchive) {
          const tmpBase = join(tmpdir(), `wicked-install-${Date.now()}`);
          mkdirSync(tmpBase, { recursive: true });
          const tmpArchive = join(tmpBase, asset.name);
          writeFileSync(tmpArchive, data);
          const isZip = asset.name.endsWith(".zip");
          if (isZip && process.platform !== "win32") {
            await execa("unzip", ["-o", tmpArchive, "-d", tmpBase]);
          } else {
            await execa("tar", ["-xf", tmpArchive, "-C", tmpBase]);
          }
          const binary = findBinary(tmpBase, id, asset.name);
          if (!binary) throw new Error(`No binary found in ${asset.name}`);
          renameSync(binary, dest);
          chmodSync(dest, 0o755);
          rmSync(tmpBase, { recursive: true, force: true });
        } else {
          writeFileSync(dest, data);
          chmodSync(dest, 0o755);
        }

        const note = install.mcpInstructions ? `\n  ${install.mcpInstructions}` : "";
        return { productId: id, success: true, skipped: false, message: `${displayName} installed to ${dest}${note}` };
      }

      case "cargo": {
        // A product may ship more than one crate (install.crates), e.g. wicked-estate
        // (the indexing CLI) + wicked-estate-mcp (the MCP server) — one without the
        // other is a broken install. Single-crate products keep using install.crate.
        const singleCrate = install.crate ?? install.package;
        const crates = Array.isArray(install.crates) && install.crates.length > 0
          ? install.crates
          : singleCrate ? [singleCrate] : [];
        if (crates.length === 0) throw new Error("install.crate or install.crates required for cargo");

        // `--version` only pins a single crate; with several, pin per-crate via name@version.
        const names = install.version && crates.length > 1
          ? crates.map((c) => `${c}@${install.version}`)
          : crates;
        const args = ["install", ...names];
        if (install.version && crates.length === 1) args.push("--version", install.version);

        // Not even the toolchain probe runs under --dry-run: a dry run spawns nothing.
        if (dryRun) {
          return plan(
            [`cargo ${args.join(" ")}    (requires the Rust toolchain: https://rustup.rs)`],
            `would run cargo ${args.join(" ")}`,
          );
        }

        // Fail with a helpful message if the Rust toolchain is missing.
        try {
          await execa("cargo", ["--version"]);
        } catch {
          return {
            productId: id, success: false, skipped: false,
            message: `cargo not found — install the Rust toolchain (https://rustup.rs) then retry, or run: cargo install ${crates.join(" ")}`,
          };
        }

        await execa("cargo", args, { stdio: "inherit" });

        const note = install.mcpInstructions ? `\n  ${install.mcpInstructions}` : "";
        return {
          productId: id, success: true, skipped: false,
          message: `${displayName} installed via cargo install ${crates.join(" ")} (binaries in ~/.cargo/bin)${note}`,
        };
      }

      case "git-plugin": {
        if (!install.repo) throw new Error("install.repo required for git-plugin");

        // Stage the repo once, then distribute its Claude assets into each config
        // dir's TOP-LEVEL discovery folders (skills/agents/commands). Claude Code
        // picks those up by convention. Copying into plugins/<id> does nothing
        // without marketplace registration, so we deliberately do not do that.
        const ASSET_DIRS = ["skills", "agents", "commands"];
        const targets = configDirs();

        if (dryRun) {
          return plan(
            [
              `git clone --depth 1 ${install.repo} <tmp>`,
              `npm install --prefix <tmp>    (when the clone has a package.json)`,
              `copy ${ASSET_DIRS.join("/, ")}/ into ${targets.join(", ")}`,
            ],
            `would clone ${install.repo} and copy its Claude assets into ${targets.join(", ")}`,
          );
        }

        const stage = join(tmpdir(), `wicked-${id}-${Date.now()}`);
        await execa("git", ["clone", "--depth", "1", install.repo, stage], { stdio: "inherit" });
        if (existsSync(join(stage, "package.json"))) {
          await execa("npm", ["install", "--prefix", stage], { stdio: "inherit" });
        }

        const written: string[] = [];
        for (const cfg of targets) {
          let any = false;
          for (const sub of ASSET_DIRS) {
            const src = join(stage, sub);
            if (!existsSync(src)) continue;
            const dst = join(cfg, sub);
            mkdirSync(dst, { recursive: true });
            for (const entry of readdirSync(src)) {
              cpSync(join(src, entry), join(dst, entry), { recursive: true });
            }
            any = true;
          }
          if (any) written.push(cfg);
        }
        rmSync(stage, { recursive: true, force: true });

        if (written.length === 0) {
          return { productId: id, success: false, skipped: false, message: `${displayName}: no skills/agents/commands found in ${install.repo}` };
        }
        const postNote = install.mcpInstructions ? `\n  ${install.mcpInstructions}` : "";
        return { productId: id, success: true, skipped: false, message: `${displayName} skills/agents/commands copied into ${written.join(", ")}${postNote}` };
      }

      default:
        return { productId: id, success: false, skipped: false, message: `Unknown install type: ${(install as { type: string }).type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { productId: id, success: false, skipped: false, message: `Failed: ${message}` };
  }
}

/**
 * A `claude-plugin` product (wicked-garden): register it with Claude Code in every
 * active config dir when the `claude` CLI is present; otherwise fall back to the
 * product's own `npx <package> install`, which only copies files into
 * ~/.claude/plugins/<id> — and say so, because Claude Code does not load that copy.
 */
async function installClaudePlugin(
  product: Product,
  options: InstallOptions,
  plan: Planner,
  log: (line: string) => void,
): Promise<InstallResult> {
  const { id, displayName, install } = product;
  const spec = claudePluginSpec(product);
  const configDirs = resolveClaudeConfigDirs({ homeFlags: options.claudeHomes });
  // Validate --source-root up front — also under --dry-run, and whether or not Claude Code is
  // present: a wrong root must fail, and a right one must never be silently ignored.
  const source = resolveMarketplaceSource(spec, options.sourceRoot);
  const fallbackArgs = install.type === "npm-run" && install.package
    ? [install.package, install.command ?? "install", ...(install.args ?? [])]
    : undefined;
  const fallbackCmd = fallbackArgs ? `npx ${fallbackArgs.join(" ")}` : undefined;
  // What the fallback writes — always ~/.claude, whatever CLAUDE_CONFIG_DIR says.
  const bareCopy = join(homedir(), ".claude", "plugins", id);
  // Legacy, unregistered copies left by earlier installers (bare plugins/<id>, or a skills/hooks
  // copy recorded by an earlier install-claude.js) are reported and LEFT IN PLACE — never removed here.
  const legacy = options.preDetectedLegacy ?? [...new Set([...configDirs.dirs, join(homedir(), ".claude")].flatMap((dir) => detectLegacyCopies(dir, spec)))];
  if (options.preDetectedLegacy === undefined) {
    for (const path of legacy) log(`  legacy ${id} copy detected at ${path} — left in place; removal will ship separately (see ${LEGACY_CLEANUP_ISSUE})`);
  }
  const legacyNote = legacy.length > 0 ? `; ${legacy.length} legacy cop${legacy.length === 1 ? "y" : "ies"} left in place (see ${LEGACY_CLEANUP_ISSUE})` : "";
  const note = (install.mcpInstructions ? `\n  ${install.mcpInstructions}` : "") + legacyNote;
  // A local checkout can only be registered through Claude Code; the npx fallback would install
  // the PUBLISHED package instead of `source`, which is not what --source-root asked for.
  const noFallbackForSourceRoot = (): Error =>
    new Error(`Claude Code CLI not detected on PATH; --source-root ${options.sourceRoot} registers ${source} through Claude Code and has no fallback — not running ${fallbackCmd ?? "the bare-copy install"}, which would install the published package instead`);

  // Both branches probe the same way (claude --version + on-disk state); a present-but-broken
  // Claude Code throws out of plan/register and is reported as a failure, never as "absent".
  if (options.dryRun) {
    const planned = planClaudePlugin(spec, { configDirs, source });
    if (planned.claudeDetected) {
      const result = plan(planned.lines, `would register ${spec.pluginId} with Claude Code in ${configDirs.dirs.join(", ")}${legacyNote}`);
      // Live policy, mirrored: a refused dir fails the product once every dir has been described.
      if (planned.failures.length > 0) throw new Error(planned.failures.join("; "));
      return { ...result, registration: "planned" };
    }
    if (options.sourceRoot) throw noFallbackForSourceRoot();
    if (options.noFallback) {
      return {
        ...plan(
          [`Claude Code CLI not detected on PATH — Claude Code is the selected target, so this would be a manual step: install Claude Code, then re-run to register ${spec.pluginId}; nothing would be copied`],
          "Claude Code CLI not detected — manual step, nothing copied",
        ),
        skipped: true,
        registration: "manual",
      };
    }
    if (!fallbackCmd) {
      // The live run fails here (below); the plan must say so and fail the same way, not report a valid plan.
      const failed = plan([`Claude Code CLI not detected on PATH and ${id} has no fallback install command — the live run fails here`], `would FAIL: Claude Code not detected and ${id} has no fallback install command`);
      return { ...failed, success: false };
    }
    return plan(
      ["Claude Code CLI not detected on PATH — would fall back to the bare copy:", `${fallbackCmd}    (copies to ${bareCopy}; not registered — Claude Code would not load it)`],
      `would run ${fallbackCmd} (copy only, not registered — Claude Code not detected)`,
    );
  }

  const outcome = registerClaudePlugin(spec, { configDirs, source, log });
  if (outcome.claudeDetected) {
    const where = Object.entries(outcome.versions).map(([dir, version]) => `${dir} (${version})`).join(", ");
    return {
      productId: id, success: true, skipped: false, registration: "registered",
      message: `${displayName} registered with Claude Code as ${spec.pluginId} in ${where}${note}`,
    };
  }

  // Only reached when NO claude binary resolves at all (PATH / WICKED_CLAUDE_BIN).
  if (options.sourceRoot) throw noFallbackForSourceRoot();
  if (options.noFallback) {
    return {
      productId: id, success: true, skipped: true, registration: "manual",
      message: `${displayName}: Claude Code CLI not detected — manual step: install Claude Code, then re-run to register ${spec.pluginId}; nothing was copied (a bare copy is loaded by nothing)`,
    };
  }
  if (!fallbackArgs || !fallbackCmd) {
    return {
      productId: id, success: false, skipped: false,
      message: `${displayName}: Claude Code CLI not detected on PATH and ${id} has no fallback install command`,
    };
  }
  log(`  Claude Code CLI not detected on PATH; falling back to ${fallbackCmd}`);
  await execa("npx", fallbackArgs, { stdio: "inherit" });
  return {
    productId: id, success: true, skipped: false, registration: "fallback",
    message: `${displayName} copied to ${bareCopy} via ${fallbackCmd}; not registered — Claude Code not detected${note}`,
  };
}
