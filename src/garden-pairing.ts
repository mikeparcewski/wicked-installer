/**
 * garden#1600: refuse to pair a wicked-garden with a wicked-crew whose engine (core-ts) is older than the
 * garden's declared floor (`wicked.coreTsFloor` in garden's package.json). garden 12.69.0 retired skills that the
 * built-in workflows of cores before core-ts 0.9.0 reference; on such a crew the first skills publish blocks and
 * every seat launch is refused. Checked before anything is installed; the fix is to upgrade crew first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { probeOnPath } from "./claude-plugin.js";

/** Gardens from 12.69.0 that predate the field carry this floor (the domain-* retirement, core#871 in core-ts 0.9.0). */
export const FIELDLESS_GARDEN_FLOOR = { fromGarden: "12.69.0", coreTs: "0.9.0" } as const;

const NUM = /^(\d+)\.(\d+)\.(\d+)/;
function below(a: string, b: string): boolean {
  const x = NUM.exec(a);
  const y = NUM.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]);
  return a.includes("-") && !b.includes("-"); // a prerelease of the same version is below it
}

/** The installed wicked-crew's package dir (behind the launcher on PATH), or undefined. */
function crewPackage(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const probe = probeOnPath("wicked-crew", env, platform);
  if (probe.state !== "found") return undefined;
  const starts: string[] = [];
  try {
    starts.push(dirname(realpathSync(probe.path)));
  } catch {
    // unreadable launcher: try the Windows shim layout
  }
  starts.push(join(dirname(probe.path), "node_modules", "wicked-crew"));
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      try {
        if ((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name === "wicked-crew") return dir;
      } catch {
        // keep walking
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}

/** The core-ts the installed crew runs: its own nested copy, else the one beside it in the global node_modules. */
export function installedCoreTs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const crew = crewPackage(env, platform);
  if (!crew) return undefined;
  for (const p of [join(crew, "node_modules", "wicked-core-ts", "package.json"), join(dirname(crew), "wicked-core-ts", "package.json")]) {
    if (!existsSync(p)) continue;
    try {
      const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: unknown }).version;
      if (typeof v === "string") return v;
    } catch {
      // unreadable: try the next
    }
  }
  return undefined;
}

/** The core-ts floor of a garden package manifest (its `wicked.coreTsFloor`, else the fieldless rule). */
export function gardenCoreFloor(manifest: { version?: unknown; wicked?: unknown }): string | undefined {
  const w = manifest.wicked as { coreTsFloor?: unknown } | undefined;
  if (typeof w?.coreTsFloor === "string" && NUM.test(w.coreTsFloor)) return w.coreTsFloor;
  return typeof manifest.version === "string" && !below(manifest.version, FIELDLESS_GARDEN_FLOOR.fromGarden) ? FIELDLESS_GARDEN_FLOOR.coreTs : undefined;
}

/** The published wicked-garden@latest manifest fields this check needs (`npm view … --json`), or undefined. */
function publishedGarden(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { version?: unknown; wicked?: unknown } | undefined {
  const r = spawnSync("npm", ["view", "wicked-garden@latest", "version", "wicked", "--json", "--fetch-retries=0"], { env, encoding: "utf8", shell: platform === "win32", timeout: 20_000 });
  if (r.status !== 0) return undefined;
  try {
    const v: unknown = JSON.parse(String(r.stdout));
    // npm unwraps a single present field: a garden without `wicked` prints just "12.69.0".
    if (typeof v === "string") return { version: v };
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as { version?: unknown; wicked?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Before garden is installed or upgraded: refuse when the crew that will run it is older than the garden's floor.
 * Not judged when wicked-crew is in the same install (it becomes crew@latest), when garden is not, or when no crew
 * is installed. Under dry-run nothing is spawned: the plan says what would be checked.
 */
/** A --source-root checkout's garden manifest (`<root>/wicked-garden/package.json`, as the host scripts stage it). */
function localGarden(sourceRoot: string): { version?: unknown; wicked?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(sourceRoot, "wicked-garden", "package.json"), "utf8")) as { version?: unknown; wicked?: unknown };
  } catch {
    return undefined;
  }
}

export function gardenPairing(opts: {
  productIds: string[];
  dryRun: boolean;
  /** --source-root: garden comes from that checkout, so its own manifest declares the floor. */
  sourceRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  published?: () => { version?: unknown; wicked?: unknown } | undefined;
}): { action: "ok" | "refused" | "noted" | "planned"; message: string } {
  if (!opts.productIds.includes("wicked-garden") || opts.productIds.includes("wicked-crew")) return { action: "ok", message: "" };
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const core = installedCoreTs(env, platform);
  if (core === undefined) return { action: "ok", message: "" };
  if (opts.sourceRoot) {
    const local = localGarden(opts.sourceRoot);
    const floor = local ? gardenCoreFloor(local) : undefined;
    if (floor !== undefined && below(core, floor)) {
      return { action: "refused", message: `this wicked-crew runs core-ts ${core}, but the wicked-garden in ${opts.sourceRoot} needs core-ts ${floor} or newer: upgrade wicked-crew first, then install wicked-garden` };
    }
    return { action: "ok", message: "" };
  }
  if (opts.dryRun) return { action: "planned", message: `dry-run: would check that wicked-garden@latest's core-ts floor is met by this wicked-crew (core-ts ${core})` };
  const manifest = (opts.published ?? (() => publishedGarden(env, platform)))();
  if (manifest === undefined) return { action: "noted", message: `could not read wicked-garden@latest's core-ts floor (npm view); this wicked-crew runs core-ts ${core}` };
  const floor = gardenCoreFloor(manifest);
  if (floor === undefined || !below(core, floor)) return { action: "ok", message: "" };
  const v = typeof manifest.version === "string" ? manifest.version : "latest";
  return {
    action: "refused",
    message: `this wicked-crew runs core-ts ${core}, but wicked-garden ${v} needs core-ts ${floor} or newer (older cores reference skills it retired, so every launch would be refused): upgrade wicked-crew first (\`npm i -g wicked-crew@latest\`, or \`npx wicked-installer install wicked-crew wicked-garden\`), then install wicked-garden`,
  };
}
