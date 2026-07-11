import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const SKIP_BINARY_EXTS = /\.(md|txt|sha256|sha512|asc|json|toml|yaml|yml|xml|html|css|js|ts)$/i;

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
import { execa } from "execa";
import type { Product, InstallResult } from "./types.js";

export async function installProduct(product: Product): Promise<InstallResult> {
  const { id, displayName, install } = product;

  try {
    switch (install.type) {
      case "npm-global": {
        if (!install.package) throw new Error("install.package required for npm-global");
        await execa("npm", ["install", "-g", install.package], { stdio: "inherit" });
        return { productId: id, success: true, skipped: false, message: `${displayName} installed globally via npm` };
      }

      case "npm-run": {
        if (!install.package) throw new Error("install.package required for npm-run");
        const cmd = install.command ?? "install";
        const args = install.args ?? [];
        await execa("npx", [install.package, cmd, ...args], { stdio: "inherit" });
        return { productId: id, success: true, skipped: false, message: `${displayName} installed via npx ${install.package} ${cmd}` };
      }

      case "manual": {
        return {
          productId: id,
          success: true,
          skipped: true,
          message: install.instructions ?? `${displayName} requires manual installation.`,
        };
      }

      case "binary": {
        return {
          productId: id,
          success: true,
          skipped: true,
          message: install.instructions ?? `${displayName} requires binary download.`,
        };
      }

      case "github-binary": {
        if (!install.githubRepo) throw new Error("install.githubRepo required for github-binary");

        const platform = process.platform;
        const arch = process.arch;
        const osName: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
        const archName: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
        const os = osName[platform] ?? platform;
        const cpu = archName[arch] ?? arch;

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

        const binDir = join(homedir(), ".local", "bin");
        mkdirSync(binDir, { recursive: true });
        const dest = join(binDir, id);

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
        const crate = install.crate ?? install.package;
        if (!crate) throw new Error("install.crate required for cargo");

        // Fail with a helpful message if the Rust toolchain is missing.
        try {
          await execa("cargo", ["--version"]);
        } catch {
          return {
            productId: id, success: false, skipped: false,
            message: `cargo not found — install the Rust toolchain (https://rustup.rs) then retry, or run: cargo install ${crate}`,
          };
        }

        const args = ["install", crate];
        if (install.version) args.push("--version", install.version);
        await execa("cargo", args, { stdio: "inherit" });

        const note = install.mcpInstructions ? `\n  ${install.mcpInstructions}` : "";
        return {
          productId: id, success: true, skipped: false,
          message: `${displayName} installed via cargo install ${crate} (binary in ~/.cargo/bin)${note}`,
        };
      }

      case "git-plugin": {
        if (!install.repo) throw new Error("install.repo required for git-plugin");

        // Stage the repo once, then distribute its Claude assets into each config
        // dir's TOP-LEVEL discovery folders (skills/agents/commands). Claude Code
        // picks those up by convention. Copying into plugins/<id> does nothing
        // without marketplace registration, so we deliberately do not do that.
        const stage = join(tmpdir(), `wicked-${id}-${Date.now()}`);
        await execa("git", ["clone", "--depth", "1", install.repo, stage], { stdio: "inherit" });
        if (existsSync(join(stage, "package.json"))) {
          await execa("npm", ["install", "--prefix", stage], { stdio: "inherit" });
        }

        const ASSET_DIRS = ["skills", "agents", "commands"];
        const written: string[] = [];
        for (const cfg of configDirs()) {
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
