import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const WIN = process.platform === "win32";

/**
 * A retired product is never installed on ANY CLI path (EXP-02).
 *
 * wicked-testing and wicked-brain are npm-DEPRECATED. The registry marks them `status: "retired"`,
 * but three install scripts (codex, opencode, pi) carried their own `--all` filter on `design`
 * alone, so `--all` acquired both — and an explicit `install-codex wicked-testing` reported
 * "installed". The fix is one predicate (src/types.ts) every path imports; these tests pin the
 * OUTCOME on every shipped entry point rather than the spelling of a filter.
 */

test("the registry still marks the retired products as retired, each naming its successors", () => {
  const byId = Object.fromEntries(registry.products.map((p) => [p.id, p]));
  for (const id of ["wicked-testing", "wicked-brain"]) {
    assert.equal(byId[id]?.status, "retired", `${id} must stay marked retired`);
    assert.ok(Array.isArray(byId[id].successors) && byId[id].successors.length > 0, `${id} names its successors`);
    for (const s of byId[id].successors) assert.ok(byId[s] && byId[s].status !== "retired", `${id} successor ${s} is a live product`);
  }
});

test("every non-retired product is installable, and no retired one is (built predicate)", async () => {
  // dist is what ships (package.json files[] is ["dist/", ...]).
  const { isInstallable, retiredRefusal } = await import("../dist/types.js");
  for (const p of registry.products) {
    assert.equal(isInstallable(p), p.status !== "design" && p.status !== "retired", `${p.id} (${p.status})`);
    assert.equal(retiredRefusal(p) !== undefined, p.status === "retired", `${p.id} refusal`);
  }
});

test("no install script carries its own lifecycle filter — each imports the shared predicate", () => {
  for (const cli of ["claude", "codex", "opencode", "pi", "antigravity"]) {
    const src = readFileSync(join(root, "src", `install-${cli}.ts`), "utf8");
    assert.match(src, /import \{ isInstallable, retiredRefusal \} from "\.\/types\.js";/, `install-${cli}.ts imports the shared predicate`);
    assert.doesNotMatch(src, /status\s*!==\s*"design"/, `install-${cli}.ts filters on status itself`);
    assert.doesNotMatch(src, /function isInstallable/, `install-${cli}.ts redefines isInstallable`);
  }
});

// ---------------------------------------------------------------------------
// Behavior on the built scripts, against a fixture registry, in a throwaway HOME.
// ---------------------------------------------------------------------------

function fx(id, status, requires = [], extra = {}) {
  return {
    id, displayName: id, description: `${id} description`, type: "npm-lib", standalone: true, opinionated: false,
    status, requires, install: { type: "npm-global", package: `${id}-pkg` }, ...extra,
  };
}

const FIXTURE = {
  version: "1",
  products: [
    fx("fx-stable", "stable"),
    fx("fx-preview", "preview"),
    { ...fx("fx-design", "design"), install: { type: "manual", instructions: "not built yet" } },
    fx("fx-old", "retired", [], { description: "RETIRED (2026-08). Its work moved to fx-stable.", successors: ["fx-stable"] }),
    fx("fx-needs-old", "active", ["fx-old"]),
  ],
  bundles: [],
};
// `--all` with an ACTIVE product that requires a retired one would (correctly) refuse the whole
// run, so the --all case uses the registry without it.
const FIXTURE_ALL = { ...FIXTURE, products: FIXTURE.products.filter((p) => p.id !== "fx-needs-old") };

const HOME_FLAG = { claude: "--claude-home", codex: "--codex-home", opencode: "--opencode-home", pi: "--pi-home", antigravity: "--gemini-home" };

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-retired-"));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(tmp, "registry.json"), JSON.stringify(FIXTURE, null, 2));
  writeFileSync(join(tmp, "registry-all.json"), JSON.stringify(FIXTURE_ALL, null, 2));
  return { tmp, home };
}

function runScript(sb, cli, args) {
  const env = {
    ...process.env,
    HOME: sb.home,
    USERPROFILE: sb.home,
    PATH: dirname(process.execPath),
    CLAUDE_CONFIG_DIR: join(sb.home, ".claude"),
    NODE_OPTIONS: "",
  };
  for (const k of ["CODEX_HOME", "OPENCODE_HOME", "PI_HOME", "GEMINI_HOME", "WICKED_CLAUDE_BIN"]) delete env[k];
  return spawnSync(process.execPath, [join(root, "dist", `install-${cli}.js`), ...args, HOME_FLAG[cli], join(sb.home, `.${cli}`), "--source-root", sb.tmp], {
    encoding: "utf8", env, timeout: 60_000,
  });
}

function lastJson(stdout) {
  for (let i = stdout.lastIndexOf("{"); i >= 0; i = stdout.lastIndexOf("{", i - 1)) {
    try { return JSON.parse(stdout.slice(i)); } catch { /* keep walking back */ }
  }
  return undefined;
}

for (const cli of Object.keys(HOME_FLAG)) {
  test(`install-${cli} --all: plans only installable products — never a retired or design one, never its package`, () => {
    const sb = sandbox();
    try {
      const r = runScript(sb, cli, ["--all", "--dry-run", "--json", "--registry", join(sb.tmp, "registry-all.json")]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const report = lastJson(r.stdout);
      assert.ok(report, `a JSON report: ${r.stdout}`);
      assert.deepEqual(report.reports.map((x) => x.productId).sort(), ["fx-preview", "fx-stable"]);
      assert.doesNotMatch(r.stdout + r.stderr, /fx-old-pkg/, "the retired package is never acquired");
    } finally {
      rmSync(sb.tmp, { recursive: true, force: true });
    }
  });

  test(`install-${cli} <retired id>: refused, exit 1, naming the successor`, () => {
    const sb = sandbox();
    try {
      const r = runScript(sb, cli, ["fx-old", "--dry-run", "--registry", join(sb.tmp, "registry.json")]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /fx-old is retired and is not installed\. Its work moved to fx-stable\. Successors: fx-stable\./);
      assert.doesNotMatch(r.stdout, /fx-old-pkg/);
    } finally {
      rmSync(sb.tmp, { recursive: true, force: true });
    }
  });

  test(`install-${cli}: a retired product pulled in through requires is refused too`, () => {
    const sb = sandbox();
    try {
      const r = runScript(sb, cli, ["fx-needs-old", "--dry-run", "--registry", join(sb.tmp, "registry.json")]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /fx-old is retired and is not installed \(required by fx-needs-old\)/);
    } finally {
      rmSync(sb.tmp, { recursive: true, force: true });
    }
  });
}

test("central `install <retired id>`: refused with the successor before anything runs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wicked-retired-central-"));
  try {
    cpSync(join(root, "dist"), join(tmp, "dist"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"), WIN ? "junction" : "dir");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
    writeFileSync(join(tmp, "registry.json"), JSON.stringify(FIXTURE, null, 2));
    const home = join(tmp, "home");
    mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), NODE_OPTIONS: "" };
    for (const [ids, re] of [
      [["fx-old"], /fx-old is retired and is not installed\. Its work moved to fx-stable\. Successors: fx-stable\./],
      [["fx-needs-old"], /fx-old is retired and is not installed \(required by fx-needs-old\)/],
    ]) {
      const r = spawnSync(process.execPath, [join(tmp, "dist", "index.js"), "install", ...ids, "--dry-run"], { encoding: "utf8", env, timeout: 60_000 });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stdout, /fx-old-pkg/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
