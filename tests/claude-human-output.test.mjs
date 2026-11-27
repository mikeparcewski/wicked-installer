// installer#105: the human (non --json) output prints what a person must act on or recover: the kept-skills path of a
// dir moved aside, and a refusal with its reason, not only "see actions".
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "POSIX symlinks" : false;

function world() {
  const home = mkdtempSync(join(tmpdir(), "wicked-claude-105-"));
  const src = join(home, "src");
  cpSync(join(ROOT, "tests", "fixtures", "wicked-bus-mini"), join(src, "wicked-bus"), { recursive: true });
  const cfg = join(home, ".claude");
  return { home, src, cfg, emit: join(cfg, "skills", "wicked-bus-emit") };
}
function node(w, argv) {
  const r = spawnSync(process.execPath, argv, { encoding: "utf8", env: { HOME: w.home, USERPROFILE: w.home, PATH: "/usr/bin:/bin", NO_COLOR: "1", FORCE_COLOR: "0" }, cwd: w.home, timeout: 60_000 });
  r.out = `${r.stdout}${r.stderr}`;
  return r;
}
const script = (...args) => [join(ROOT, "dist", "install-claude.js"), ...args];

test("standalone install: the human output names where a person's dir was moved", { skip }, () => {
  const w = world();
  try {
    mkdirSync(w.emit, { recursive: true });
    writeFileSync(join(w.emit, "SKILL.md"), "---\nname: wicked-bus-emit\n---\nmine\n");
    const r = node(w, script("wicked-bus", "--skip-binaries", "--source-root", w.src, "--claude-home", w.cfg));
    assert.equal(r.status, 0, r.out);
    const keptDir = join(w.cfg, "wicked-installer", "kept-skills");
    const [kept] = readdirSync(keptDir);
    assert.ok(r.stdout.includes(`  skills/wicked-bus-emit: a skill dir this installer did not write; moved to ${join(keptDir, kept)} before the install\n`), r.stdout);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("uninstall: a refused removal and its reason are in the human output (standalone and central)", { skip }, () => {
  for (const central of [false, true]) {
    const w = world();
    try {
      let r = node(w, script("wicked-bus", "--skip-binaries", "--source-root", w.src, "--claude-home", w.cfg));
      assert.equal(r.status, 0, r.out);
      rmSync(w.emit, { recursive: true, force: true });
      mkdirSync(join(w.home, "elsewhere"));
      symlinkSync(join(w.home, "elsewhere"), w.emit); // a recorded skill dir is now a link: the uninstall refuses it
      r = node(w, central ? [join(ROOT, "dist", "index.js"), "uninstall", "wicked-bus", "--claude-home", w.cfg] : script("uninstall", "wicked-bus", "--claude-home", w.cfg));
      assert.match(r.stdout, /^ +skills\/wicked-bus-emit: .*symlink/m, `${central ? "central" : "standalone"}:\n${r.out}`);
    } finally {
      rmSync(w.home, { recursive: true, force: true });
    }
  }
});

// A note that already says "<target> <detail>" (installer#99's refused-move note) is not printed twice.
test("uninstall: a refused move that a note already names is printed once", { skip: skip || (process.getuid?.() === 0 ? "root ignores the mode" : false) }, () => {
  const w = world();
  try {
    mkdirSync(join(w.cfg, "wicked-installer"), { recursive: true });
    writeFileSync(join(w.cfg, "wicked-installer", "claude-install.json"), JSON.stringify({ products: [{ id: "wicked-bus" }] })); // a v1 marker
    mkdirSync(w.emit, { recursive: true });
    writeFileSync(join(w.emit, "SKILL.md"), "---\nname: wicked-bus-emit\n---\nwicked-bus\n");
    chmodSync(w.emit, 0o555);
    const r = node(w, script("uninstall", "wicked-bus", "--claude-home", w.cfg));
    chmodSync(w.emit, 0o755);
    assert.equal((r.stdout.match(/skills\/wicked-bus-emit:? not moved/g) ?? []).length, 1, r.stdout);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});
