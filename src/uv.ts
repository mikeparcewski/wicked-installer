/**
 * Crew builds every job's skills environment with `uv sync`; acquiring crew without uv leaves
 * an installed daemon that refuses all launches. Check this prerequisite before any product is
 * installed, using filesystem probes only, and let Astral's installer manage its own PATH fix.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { probeOnPath } from "./claude-plugin.js";
import { exeName, pathFix } from "./release-binary.js";

interface UvLocations {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** PATH wins; the remaining locations cover current Astral installs and pre-0.5 cargo installs. */
export function findUv(opts: UvLocations = {}): { path: string; onPath: boolean } | undefined {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
  const file = exeName("uv", platform);
  const probe = probeOnPath(file, env, platform);
  if (probe.state === "found") return { path: probe.path, onPath: true };
  const dirs = [env.UV_INSTALL_DIR, env.XDG_BIN_HOME, join(home, ".local", "bin"), join(home, ".cargo", "bin"), env.CARGO_HOME ? join(env.CARGO_HOME, "bin") : undefined];
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, file);
    try {
      if (!statSync(path).isFile()) continue;
      if (platform !== "win32") accessSync(path, fsConstants.X_OK);
      return { path, onPath: false };
    } catch {
      // Missing, inaccessible, or non-executable is not a usable uv; try the next location.
    }
  }
  return undefined;
}

/** Official standalone commands; env is a probe seam so the wget fallback is deterministic. */
export function uvInstallCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"';
  const downloader = probeOnPath("curl", env, platform).state !== "found" && probeOnPath("wget", env, platform).state === "found"
    ? "wget -qO-" : "curl -LsSf";
  return `${downloader} https://astral.sh/uv/install.sh | sh`;
}

export interface EnsureUvOptions extends UvLocations {
  needed: boolean;
  dryRun: boolean;
  offline: boolean;
  confirm?: () => Promise<boolean>;
  run?: (command: string, platform: NodeJS.Platform) => { status: number | null; error?: string };
  log?: (line: string) => void;
}

export interface UvResult {
  ok: boolean;
  action: "not-needed" | "present" | "planned" | "installed" | "declined" | "failed" | "offline";
  path?: string;
  message: string;
}

/** A successful exit alone proves nothing: re-probe because a profile edit cannot change this process's PATH. */
export async function ensureUv(opts: EnsureUvOptions): Promise<UvResult> {
  if (!opts.needed) return { ok: true, action: "not-needed", message: "uv is not needed for this install." };
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const located = (found: NonNullable<ReturnType<typeof findUv>>): string =>
    `uv at ${found.path}${found.onPath ? " (on PATH)" : ` (not on PATH; ${pathFix(dirname(found.path), platform)})`}`;
  const found = findUv(opts);
  if (found) return { ok: true, action: "present", path: found.path, message: `Found ${located(found)}.` };
  const command = uvInstallCommand(platform, env);
  const instruction = `wicked-crew needs uv: its daemon builds the skills environment every job uses with uv. Install it with: ${command}  (https://docs.astral.sh/uv/getting-started/installation/), then run the installer again.`;
  if (opts.dryRun) return { ok: true, action: "planned", message: `Would install uv with: ${command}` };
  if (opts.offline) return { ok: false, action: "offline", message: instruction };
  if (opts.confirm && !await opts.confirm()) return { ok: false, action: "declined", message: instruction };
  opts.log?.(`Installing uv with: ${command}`);
  const run = opts.run ?? ((cmd: string, target: NodeJS.Platform) => {
    // PowerShell receives its script as one argument on Windows; POSIX uses the documented pipe.
    // Do not disable profile modification: Astral knows the platform-correct persistent PATH fix.
    const result = target === "win32"
      ? spawnSync("powershell", ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"], { env, stdio: "inherit" })
      : spawnSync(cmd, { env, shell: true, stdio: "inherit" });
    return { status: result.status, error: result.error?.message };
  });
  try {
    const result = run(command, platform);
    const installed = findUv(opts);
    if (result.status === 0 && !result.error && installed) {
      // astral's installer has just added its folder to the shell profile (.zshrc/.profile, or the
      // Windows user PATH); only this process's PATH is stale. Say that, not "edit your profile".
      const where = installed.onPath ? "(on PATH)" : "(astral's installer added its folder to your shell's PATH: open a new terminal to use it there)";
      return { ok: true, action: "installed", path: installed.path, message: `Installed uv at ${installed.path} ${where}.` };
    }
  } catch {
    // Spawn errors and installer failures share the same actionable instruction as a refusal.
  }
  return { ok: false, action: "failed", message: instruction };
}
