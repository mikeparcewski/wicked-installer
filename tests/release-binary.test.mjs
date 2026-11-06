// release-binary.test.mjs — a `cargo` product with prebuilt release archives installs WITHOUT Rust:
// the archive for this platform, sha256-verified against the release's SHA256SUMS, into
// ~/.local/bin. cargo is used only when the release has no archive for the platform; a checksum
// mismatch installs nothing and never falls back. Network-free: a local HTTP server stands in for
// the GitHub API (WICKED_RELEASE_API_BASE), PATH holds a recording fake cargo (or none), and HOME
// is a temp dir. Requires `npm run build` first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const skip = process.platform === "win32"; // fake binaries are sh scripts

const { releaseTriple, findInstalledBinary } = await import("../dist/release-binary.js");
const TRIPLE = releaseTriple();

const REGISTRY = {
  version: "1",
  products: [{
    id: "fake-estate", displayName: "Fake Estate", description: "x", type: "mcp-binary", standalone: true, opinionated: false, status: "stable", requires: [],
    install: {
      type: "cargo", crates: ["fake-estate", "fake-estate-mcp"], crate: "fake-estate-mcp",
      release: { githubRepo: "acme/fake-estate", binaries: ["fake-estate", "fake-estate-mcp"], assetPrefix: "fake-estate", checksums: "SHA256SUMS" },
    },
  }],
  bundles: [],
};

/** A temp world: HOME, a registry, a release archive for `triple`, and a bin dir for PATH. */
function world({ triple = TRIPLE, badSum = false, withCargo = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wicked-release-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const reg = join(root, "registry.json");
  writeFileSync(reg, JSON.stringify(REGISTRY));
  // The archive: <prefix>-9.9.9-<triple>/{fake-estate,fake-estate-mcp}
  const stage = join(root, "stage", `fake-estate-9.9.9-${triple}`);
  mkdirSync(stage, { recursive: true });
  for (const b of ["fake-estate", "fake-estate-mcp"]) {
    writeFileSync(join(stage, b), `#!/bin/sh\necho "${b} 9.9.9"\n`);
    chmodSync(join(stage, b), 0o755);
  }
  const asset = `fake-estate-9.9.9-${triple}.tar.gz`;
  const archive = join(root, asset);
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", join(root, "stage"), `fake-estate-9.9.9-${triple}`]).status, 0);
  const bytes = readFileSync(archive);
  const sum = badSum ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
  if (withCargo) {
    writeFileSync(join(bin, "cargo"), `#!/bin/sh\necho "$@" >> "${join(root, "cargo.log")}"\nexit 0\n`);
    chmodSync(join(bin, "cargo"), 0o755);
  }
  return { root, home, bin, reg, asset, bytes, sums: `${sum}  ${asset}\n`, cargoLog: join(root, "cargo.log") };
}

/** Serve the fake release; returns { base, hits, close }. */
async function serve(w) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/repos/acme/fake-estate/releases/latest") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        tag_name: "v9.9.9",
        assets: [
          { name: w.asset, browser_download_url: `${base}/dl/${w.asset}` },
          { name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` },
        ],
      }));
    } else if (req.url === `/dl/${w.asset}`) {
      res.end(w.bytes);
    } else if (req.url === "/dl/SHA256SUMS") {
      res.end(w.sums);
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

/** Run a script ASYNCHRONOUSLY so the in-process server can answer. */
function runAsync(args, w, base, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: w.home, USERPROFILE: w.home, PATH: `${w.bin}:/usr/bin:/bin`, WICKED_RELEASE_API_BASE: base, ...extraEnv };
    delete env.CLAUDE_CONFIG_DIR;
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
}

const piArgs = (w, extra = []) => [join(ROOT, "dist", "install-pi.js"), "fake-estate", "--registry", w.reg, "--pi-home", join(w.home, ".pi", "agent"), ...extra];

test("release: installs both binaries from the sha256-verified archive into ~/.local/bin — no Rust", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    const r = await runAsync(piArgs(w), w, srv.base);
    assert.equal(r.status, 0, r.out);
    for (const b of ["fake-estate", "fake-estate-mcp"]) {
      const p = join(w.home, ".local", "bin", b);
      assert.ok(existsSync(p), `${b} installed`);
      assert.match(spawnSync(p, [], { encoding: "utf8" }).stdout, /9\.9\.9/);
    }
    assert.match(r.out, /sha256 [0-9a-f]{12}… verified against the release's SHA256SUMS/);
    assert.ok(!existsSync(w.cargoLog), "cargo never ran");
    // The detector finds it off PATH; status would say installed.
    assert.equal(findInstalledBinary("fake-estate-mcp", { home: w.home, env: { PATH: w.bin } })?.source, "~/.local/bin");

    // Re-run converges: already current, nothing downloaded again.
    const before = srv.hits.length;
    const again = await runAsync(piArgs(w), w, srv.base);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /already installed/);
    assert.deepEqual(srv.hits.slice(before), ["/repos/acme/fake-estate/releases/latest"], "only the release lookup");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: a checksum mismatch installs NOTHING and never falls back to cargo", { skip: skip || !TRIPLE }, async () => {
  const w = world({ badSum: true, withCargo: true });
  const srv = await serve(w);
  try {
    const r = await runAsync(piArgs(w), w, srv.base);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /sha256 mismatch for fake-estate-9\.9\.9-.*refusing to install it; nothing was installed/);
    assert.ok(!existsSync(join(w.home, ".local", "bin", "fake-estate")));
    assert.ok(!existsSync(join(w.home, ".local", "bin", "fake-estate-mcp")));
    assert.ok(!existsSync(w.cargoLog), "no cargo fallback after a verification failure");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: no archive for this platform falls back to cargo; without cargo the message is honest and gives a working fix", { skip: skip || !TRIPLE }, async () => {
  const withCargo = world({ triple: "sparc-sun-solaris", withCargo: true });
  let srv = await serve(withCargo);
  try {
    const r = await runAsync(piArgs(withCargo), withCargo, srv.base);
    assert.equal(r.status, 0, r.out);
    assert.match(readFileSync(withCargo.cargoLog, "utf8"), /^install fake-estate fake-estate-mcp$/m);
  } finally {
    await srv.close();
    rmSync(withCargo.root, { recursive: true, force: true });
  }

  const noCargo = world({ triple: "sparc-sun-solaris" });
  srv = await serve(noCargo);
  try {
    const r = await runAsync(piArgs(noCargo, ["--json"]), noCargo, srv.base);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /has no .* archive \(no prebuilt binary for this platform\), and building it from source needs the Rust toolchain, which is not installed \(cargo not found\)\. Fix: install Rust from https:\/\/rustup\.rs, open a new terminal, then run: cargo install fake-estate fake-estate-mcp/);
  } finally {
    await srv.close();
    rmSync(noCargo.root, { recursive: true, force: true });
  }
});

test("release: --dry-run prints the plan and fetches nothing", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    const r = await runAsync(piArgs(w, ["--dry-run"]), w, srv.base);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry-run: download the .* archive and SHA256SUMS; verify its sha256/);
    assert.deepEqual(srv.hits, [], "no request under --dry-run");
    assert.ok(!existsSync(join(w.home, ".local")));
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: the central `install` path uses the release too (the readiness fix now works without Rust)", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  // index.js reads ../registry.json: run a copy of dist next to the fake registry.
  const app = join(w.root, "app");
  mkdirSync(app);
  spawnSync("cp", ["-R", join(ROOT, "dist"), join(app, "dist")]);
  writeFileSync(join(app, "registry.json"), JSON.stringify(REGISTRY));
  writeFileSync(join(app, "package.json"), readFileSync(join(ROOT, "package.json")));
  spawnSync("ln", ["-s", join(ROOT, "node_modules"), join(app, "node_modules")]);
  try {
    const r = await runAsync([join(app, "dist", "index.js"), "install", "fake-estate", "--offline"], w, srv.base);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Fake Estate installed — installed fake-estate \+ fake-estate-mcp v9\.9\.9/);
    assert.ok(existsSync(join(w.home, ".local", "bin", "fake-estate-mcp")));
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

/** Binaries already in ~/.local/bin (a release install), NOT on PATH; returns the world. */
function preinstalled() {
  const w = world();
  const local = join(w.home, ".local", "bin");
  mkdirSync(local, { recursive: true });
  for (const b of ["fake-estate", "fake-estate-mcp"]) {
    writeFileSync(join(local, b), "#!/bin/sh\necho 9.9.9\n");
    chmodSync(join(local, b), 0o755);
  }
  const reg = { ...REGISTRY, products: [{ ...REGISTRY.products[0], mcp: { "fake-estate": { command: "fake-estate-mcp", args: [] } } }] };
  writeFileSync(w.reg, JSON.stringify(reg));
  return { ...w, local };
}

function runSync(args, w) {
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home, PATH: `${w.bin}:/usr/bin:/bin` };
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 60_000 });
  r.out = `${r.stdout}${r.stderr}`;
  return r;
}

test("release: OpenCode registers the MCP binary where it actually is (~/.local/bin), not only ~/.cargo/bin", { skip }, () => {
  const w = preinstalled();
  try {
    const log = join(w.root, "opencode.log");
    writeFileSync(join(w.bin, "opencode"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
    chmodSync(join(w.bin, "opencode"), 0o755);
    const r = runSync([join(ROOT, "dist", "install-opencode.js"), "fake-estate", "--registry", w.reg, "--opencode-home", join(w.home, ".config", "opencode"), "--skip-binaries"], w);
    assert.equal(r.status, 0, r.out);
    assert.match(readFileSync(log, "utf8"), new RegExp(`^mcp add fake-estate -- ${join(w.local, "fake-estate-mcp").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: Claude Code's MCP entry uses the absolute ~/.local/bin path when the dir is not on PATH", { skip }, () => {
  const w = preinstalled();
  try {
    const cfg = join(w.home, "cfg");
    const r = runSync([join(ROOT, "dist", "install-claude.js"), "fake-estate", "--registry", w.reg, "--claude-home", cfg, "--skip-binaries"], w);
    assert.equal(r.status, 0, r.out);
    const state = JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8"));
    assert.equal(state.mcpServers["fake-estate"].command, join(w.local, "fake-estate-mcp"));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("unit: target triples and checksum parsing are platform-independent", async () => {
  const { releaseTriple: triple, parseChecksums } = await import("../dist/release-binary.js");
  assert.equal(triple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(triple("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(triple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(triple("linux", "x64", true), "x86_64-unknown-linux-gnu");
  assert.equal(triple("linux", "arm64", true), "aarch64-unknown-linux-gnu");
  assert.equal(triple("linux", "x64", false), undefined, "musl gets cargo, not a glibc binary");
  assert.equal(triple("win32", "arm64"), undefined);
  const sums = parseChecksums(`${"a".repeat(64)}  one.tar.gz\n${"B".repeat(64)} *two.zip\r\nnot a line\n`);
  assert.equal(sums.get("one.tar.gz"), "a".repeat(64));
  assert.equal(sums.get("two.zip"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("release: 'already current' needs every binary to hash as installed — a changed MCP binary is re-downloaded", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    assert.equal((await runAsync(piArgs(w), w, srv.base)).status, 0);
    const mcp = join(w.home, ".local", "bin", "fake-estate-mcp");
    writeFileSync(mcp, "#!/bin/sh\necho fake-estate-mcp 1.0.0\n"); // stale / tampered, same name
    const before = srv.hits.length;
    const again = await runAsync(piArgs(w), w, srv.base);
    assert.equal(again.status, 0, again.out);
    assert.doesNotMatch(again.out, /already installed/);
    assert.ok(srv.hits.slice(before).some((h) => h.startsWith("/dl/fake-estate-9.9.9")), "downloaded and verified again");
    assert.match(spawnSync(mcp, [], { encoding: "utf8" }).stdout, /9\.9\.9/, "repaired");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: a failed replacement restores the previous binaries (never a half-updated pair)", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    const local = join(w.home, ".local", "bin");
    mkdirSync(local, { recursive: true });
    for (const b of ["fake-estate", "fake-estate-mcp"]) {
      writeFileSync(join(local, b), `#!/bin/sh\necho old ${b}\n`);
      chmodSync(join(local, b), 0o755);
    }
    // The SECOND swap fails, after the first binary has already been replaced.
    const r = await runAsync(piArgs(w), w, srv.base, { WICKED_RELEASE_TEST_FAIL_SWAP: "2" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /could not write to .*injected swap failure.*; the previous binaries were restored/);
    for (const b of ["fake-estate", "fake-estate-mcp"]) {
      assert.equal(readFileSync(join(local, b), "utf8"), `#!/bin/sh\necho old ${b}\n`, `${b} restored`);
    }
    assert.deepEqual(readdirSync(local).sort(), ["fake-estate", "fake-estate-mcp"], "no staged or backup files left");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: MCP wiring prefers the verified release install over an older copy on PATH", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    assert.equal((await runAsync(piArgs(w), w, srv.base)).status, 0);
    // An older cargo build that IS on PATH.
    writeFileSync(join(w.bin, "fake-estate-mcp"), "#!/bin/sh\necho old\n");
    chmodSync(join(w.bin, "fake-estate-mcp"), 0o755);
    const reg = { ...REGISTRY, products: [{ ...REGISTRY.products[0], mcp: { "fake-estate": { command: "fake-estate-mcp", args: [] } } }] };
    writeFileSync(w.reg, JSON.stringify(reg));
    const cfg = join(w.home, "cfg");
    const r = runSync([join(ROOT, "dist", "install-claude.js"), "fake-estate", "--registry", w.reg, "--claude-home", cfg, "--skip-binaries"], w);
    assert.equal(r.status, 0, r.out);
    const state = JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8"));
    assert.equal(state.mcpServers["fake-estate"].command, join(w.home, ".local", "bin", "fake-estate-mcp"));
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: --purge-binaries removes the release binaries it installed and keeps a changed one", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    assert.equal((await runAsync(piArgs(w), w, srv.base)).status, 0);
    const { purgeReleaseBinaries } = await import("../dist/release-binary.js");
    const spec = REGISTRY.products[0].install.release;
    const local = join(w.home, ".local", "bin");
    writeFileSync(join(local, "fake-estate"), "#!/bin/sh\necho mine\n");
    const out = purgeReleaseBinaries(spec, { dryRun: false, home: w.home });
    assert.deepEqual(out.kept, [join(local, "fake-estate")]);
    assert.ok(existsSync(join(local, "fake-estate")), "a changed binary is kept");
    assert.ok(!existsSync(join(local, "fake-estate-mcp")), "the installed, unchanged one is removed");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: a file this installer did not put in ~/.local/bin is kept (renamed and reported), and a non-runnable install is repaired", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    const local = join(w.home, ".local", "bin");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "fake-estate"), "#!/bin/sh\necho my own wrapper\n");
    chmodSync(join(local, "fake-estate"), 0o755);
    const r = await runAsync(piArgs(w), w, srv.base);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /kept the file that was there before \(not installed by this installer\) as .*fake-estate\.replaced-/);
    const kept = readdirSync(local).find((n) => n.startsWith("fake-estate.replaced-"));
    assert.equal(readFileSync(join(local, kept), "utf8"), "#!/bin/sh\necho my own wrapper\n");

    // Same bytes, but no longer executable: not "already installed".
    chmodSync(join(local, "fake-estate-mcp"), 0o644);
    const again = await runAsync(piArgs(w), w, srv.base);
    assert.equal(again.status, 0, again.out);
    assert.doesNotMatch(again.out, /already installed/);
    assert.equal(spawnSync(join(local, "fake-estate-mcp"), [], { encoding: "utf8" }).status, 0, "runnable again");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("release: `install-claude.js uninstall <id> --purge-binaries` removes the release binaries, and fails (exit 1) when it must keep a changed one", { skip: skip || !TRIPLE }, async () => {
  const w = world();
  const srv = await serve(w);
  try {
    const cfg = join(w.home, "cfg");
    const claude = (args, extra) => runAsync([join(ROOT, "dist", "install-claude.js"), ...args, "--registry", w.reg, "--claude-home", cfg], w, srv.base, extra);
    assert.equal((await claude(["fake-estate"])).status, 0);
    const local = join(w.home, ".local", "bin");
    writeFileSync(join(local, "fake-estate"), "#!/bin/sh\necho changed\n");
    const kept = await claude(["uninstall", "fake-estate", "--purge-binaries"]);
    assert.equal(kept.status, 1, kept.out);
    assert.match(kept.out, /binary purge is incomplete/);
    assert.ok(existsSync(join(local, "fake-estate")), "the changed binary is kept");
    assert.ok(!existsSync(join(local, "fake-estate-mcp")), "the unchanged one is removed");
  } finally {
    await srv.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});
