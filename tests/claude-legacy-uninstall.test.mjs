// installer#99: on a v1 (legacy) marker, Claude's uninstall cannot tell its own skill copy from a person's dir of the
// same name or signature. It moves a matching skill dir to <config>/wicked-installer/kept-skills/, never deletes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "POSIX fixture paths" : false;

function world() {
  const home = mkdtempSync(join(tmpdir(), "wicked-claude-v1-"));
  const cfg = join(home, ".claude");
  mkdirSync(join(cfg, "wicked-installer"), { recursive: true });
  // The v1 shape: a products array, no markerVersion, and no record of which skill paths were written.
  writeFileSync(join(cfg, "wicked-installer", "claude-install.json"), JSON.stringify({ products: [{ id: "wicked-bus", success: true, skipped: false }] }));
  const skill = (name, body) => { mkdirSync(join(cfg, "skills", name), { recursive: true }); writeFileSync(join(cfg, "skills", name, "SKILL.md"), body); };
  // The person's own dir under the bus's prefix and naming the bus, and one the old installer may have written.
  skill("wicked-bus-emit", "---\nname: wicked-bus-emit\n---\nMY OWN wicked-bus NOTES\n");
  skill("wicked-bus-status", "---\nname: wicked-bus-status\n---\nwicked-bus status\n");
  skill("unrelated", "---\nname: unrelated\n---\nnot the bus\n");
  return { home, cfg };
}
const run = (w, extra = []) => spawnSync(process.execPath, [join(ROOT, "dist", "install-claude.js"), "uninstall", "wicked-bus", "--claude-home", w.cfg, "--json", ...extra], { encoding: "utf8", env: { HOME: w.home, USERPROFILE: w.home, PATH: "/usr/bin:/bin", NO_COLOR: "1" }, timeout: 60_000 });

test("Claude v1-marker uninstall moves a matching skill dir to kept-skills, content intact, never deletes it", { skip }, () => {
  const w = world();
  try {
    const r = run(w);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const report = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
    assert.equal(report.heuristic, true, JSON.stringify(report));
    const keptDir = join(w.cfg, "wicked-installer", "kept-skills");
    assert.ok(existsSync(keptDir), "no kept-skills dir: the matching skill dirs were deleted, not kept");
    const kept = readdirSync(keptDir).sort();
    assert.equal(kept.length, 2, kept.join(", "));
    assert.ok(kept[0].startsWith("wicked-bus-emit-") && kept[1].startsWith("wicked-bus-status-"), kept.join(", "));
    assert.equal(readFileSync(join(keptDir, kept[0], "SKILL.md"), "utf8"), "---\nname: wicked-bus-emit\n---\nMY OWN wicked-bus NOTES\n", "the person's dir is kept byte-identical");
    assert.equal(existsSync(join(w.cfg, "skills", "wicked-bus-emit")), false, "the product's skills are gone from skills/");
    assert.equal(existsSync(join(w.cfg, "skills", "wicked-bus-status")), false);
    assert.equal(readFileSync(join(w.cfg, "skills", "unrelated", "SKILL.md"), "utf8"), "---\nname: unrelated\n---\nnot the bus\n", "an unrelated skill is untouched");
    const moves = report.actions.filter((a) => a.kind === "remove" && a.target?.startsWith("skills/"));
    assert.deepEqual(moves.map((a) => [a.target, a.result]).sort(), [["skills/wicked-bus-emit", "ok"], ["skills/wicked-bus-status", "ok"]]);
    for (const a of moves) assert.match(a.detail, /^moved to .*kept-skills\/wicked-bus-(emit|status)-.*: a v1 marker cannot tell the installer's copy from yours, so it is kept, not deleted$/, a.detail);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("Claude v1-marker uninstall under --dry-run moves nothing and says it would move", { skip }, () => {
  const w = world();
  try {
    const r = run(w, ["--dry-run"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(existsSync(join(w.cfg, "wicked-installer", "kept-skills")), false);
    assert.equal(readFileSync(join(w.cfg, "skills", "wicked-bus-emit", "SKILL.md"), "utf8"), "---\nname: wicked-bus-emit\n---\nMY OWN wicked-bus NOTES\n");
    const report = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
    const planned = report.actions.filter((a) => a.kind === "remove" && a.target?.startsWith("skills/"));
    assert.deepEqual(planned.map((a) => a.result), ["planned", "planned"]);
    assert.match(planned[0].detail, /would move to wicked-installer\/kept-skills\//);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("Claude v1-marker uninstall: the human output names where each kept dir went (direct script and central uninstall)", { skip }, () => {
  for (const central of [false, true]) {
    const w = world();
    try {
      const env = { HOME: w.home, USERPROFILE: w.home, PATH: "/usr/bin:/bin", NO_COLOR: "1", FORCE_COLOR: "0" };
      const argv = central
        ? [join(ROOT, "dist", "index.js"), "uninstall", "wicked-bus", "--claude-home", w.cfg]
        : [join(ROOT, "dist", "install-claude.js"), "uninstall", "wicked-bus", "--claude-home", w.cfg];
      const r = spawnSync(process.execPath, argv, { encoding: "utf8", env, cwd: w.home, timeout: 60_000 });
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 0, out);
      const kept = readdirSync(join(w.cfg, "wicked-installer", "kept-skills"));
      assert.equal(kept.length, 2, out);
      for (const name of kept) {
        const at = join(w.cfg, "wicked-installer", "kept-skills", name);
        assert.ok(out.includes(` kept at ${at} `), `${central ? "central" : "direct"} output names ${at}:\n${out}`);
      }
    } finally {
      rmSync(w.home, { recursive: true, force: true });
    }
  }
});

// PARTIAL FAILURE: one matching dir moves, the next one cannot (a dir changing parent needs write access to itself).
// The moved one stays kept, the other stays in place, the marker keeps the record, and a re-run finishes the job.
test("Claude v1-marker uninstall: a move that fails after another succeeded keeps the record; a re-run finishes", { skip: skip || (process.getuid?.() === 0 ? "root ignores the mode" : false) }, () => {
  const w = world();
  const stuck = join(w.cfg, "skills", "wicked-bus-status");
  const markerFile = join(w.cfg, "wicked-installer", "claude-install.json");
  try {
    chmodSync(stuck, 0o555);
    let r = run(w);
    chmodSync(stuck, 0o755);
    assert.notEqual(r.status, 0, r.stdout);
    let report = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
    const byTarget = Object.fromEntries(report.actions.filter((a) => a.target?.startsWith("skills/")).map((a) => [a.target, a]));
    assert.equal(byTarget["skills/wicked-bus-emit"].result, "ok");
    assert.equal(byTarget["skills/wicked-bus-status"].result, "failed");
    assert.match(byTarget["skills/wicked-bus-status"].detail, /^not moved \(.*\); the dir is left in place$/);
    assert.equal(readFileSync(join(stuck, "SKILL.md"), "utf8"), "---\nname: wicked-bus-status\n---\nwicked-bus status\n", "the dir that failed to move is intact in place");
    const keptDir = join(w.cfg, "wicked-installer", "kept-skills");
    assert.deepEqual(readdirSync(keptDir).map((n) => n.replace(/-\d{4}-.*$/, "")), ["wicked-bus-emit"]);
    assert.deepEqual(JSON.parse(readFileSync(markerFile, "utf8")).products.map((p) => p.id), ["wicked-bus"], "the record is kept for a re-run");

    r = run(w);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(keptDir).map((n) => n.replace(/-\d{4}-.*$/, "")).sort(), ["wicked-bus-emit", "wicked-bus-status"]);
    assert.equal(existsSync(stuck), false);
    assert.equal(existsSync(markerFile), false, "the last record gone, the marker file goes; kept-skills stays");
  } finally {
    if (existsSync(stuck)) chmodSync(stuck, 0o755);
    rmSync(w.home, { recursive: true, force: true });
  }
});
