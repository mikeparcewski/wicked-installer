// installer#104: a v2 marker's skill dir record is a pathname, not proof. A person who replaces the installer's copy
// with their own dir of the same name must not lose it on the next install or uninstall: the record carries a content
// fingerprint, and only a dir that still matches it is replaced or removed. Anything else moves to kept-skills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "POSIX fixture paths" : false;
const MINE = "---\nname: wicked-bus-emit\n---\nMY OWN NOTES, written after the install\n";

function world() {
  const home = mkdtempSync(join(tmpdir(), "wicked-claude-104-"));
  const src = join(home, "src");
  cpSync(join(ROOT, "tests", "fixtures", "wicked-bus-mini"), join(src, "wicked-bus"), { recursive: true });
  const cfg = join(home, ".claude");
  return { home, src, cfg, marker: join(cfg, "wicked-installer", "claude-install.json"), emit: join(cfg, "skills", "wicked-bus-emit") };
}
function run(w, verb) {
  const args = verb === "install"
    ? ["wicked-bus", "--skip-binaries", "--source-root", w.src, "--claude-home", w.cfg, "--json"]
    : ["uninstall", "wicked-bus", "--claude-home", w.cfg, "--json"];
  const r = spawnSync(process.execPath, [join(ROOT, "dist", "install-claude.js"), ...args], { encoding: "utf8", env: { HOME: w.home, USERPROFILE: w.home, PATH: "/usr/bin:/bin", NO_COLOR: "1" }, timeout: 60_000 });
  assert.equal(r.status, 0, `${verb}: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
}
function replaceWithMine(w) {
  rmSync(w.emit, { recursive: true, force: true });
  mkdirSync(w.emit);
  writeFileSync(join(w.emit, "SKILL.md"), MINE);
}
const keptDir = (w) => join(w.cfg, "wicked-installer", "kept-skills");
const keptNames = (w) => (existsSync(keptDir(w)) ? readdirSync(keptDir(w)) : []);
const skillRecords = (w) => JSON.parse(readFileSync(w.marker, "utf8")).products["wicked-bus"].files.filter((f) => f.kind === "dir" && f.path.startsWith("skills/"));

test("install records a content fingerprint with each skill dir, and an unchanged copy is replaced in place on reinstall", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    const recs = skillRecords(w);
    assert.equal(recs.length, 2, JSON.stringify(recs));
    for (const rec of recs) assert.match(rec.sha256 ?? "", /^[0-9a-f]{64}$/, JSON.stringify(rec));
    const again = run(w, "install");
    assert.deepEqual(keptNames(w), [], "the installer's own unchanged copies are not moved aside");
    assert.equal(again.actions.filter((a) => a.kind === "collision-moved").length, 0);
    assert.deepEqual(skillRecords(w).map((r) => r.sha256), recs.map((r) => r.sha256), "same content, same fingerprint");
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("reinstall keeps a person's dir that replaced a recorded skill dir (moved to kept-skills, never deleted)", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    replaceWithMine(w);
    const r = run(w, "install");
    const kept = keptNames(w);
    assert.equal(kept.length, 1, `the person's dir was deleted, not kept: ${JSON.stringify(r.actions)}`);
    assert.equal(readFileSync(join(keptDir(w), kept[0], "SKILL.md"), "utf8"), MINE);
    assert.notEqual(readFileSync(join(w.emit, "SKILL.md"), "utf8"), MINE, "the product's copy is back in place");
    assert.deepEqual(r.actions.filter((a) => a.kind === "collision-moved").map((a) => a.target), ["skills/wicked-bus-emit"]);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("uninstall keeps a person's dir that replaced a recorded skill dir, and removes the unchanged one", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    replaceWithMine(w);
    run(w, "uninstall");
    const kept = keptNames(w);
    assert.equal(kept.length, 1, "the person's dir was deleted, not kept");
    assert.equal(readFileSync(join(keptDir(w), kept[0], "SKILL.md"), "utf8"), MINE);
    assert.equal(existsSync(w.emit), false);
    assert.equal(existsSync(join(w.cfg, "skills", "wicked-bus-status")), false, "the unchanged copy is removed as before");
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("a skill dir record written before fingerprints is not proof: reinstall moves that dir aside once, then records it", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    const m = JSON.parse(readFileSync(w.marker, "utf8"));
    for (const f of m.products["wicked-bus"].files) delete f.sha256; // the shape every installer before #104 wrote
    writeFileSync(w.marker, JSON.stringify(m, null, 2));
    replaceWithMine(w);
    run(w, "install");
    assert.equal(keptNames(w).length >= 1, true, "no fingerprint: the dir is kept, not deleted");
    assert.ok(keptNames(w).some((n) => readFileSync(join(keptDir(w), n, "SKILL.md"), "utf8") === MINE));
    for (const rec of skillRecords(w)) assert.match(rec.sha256 ?? "", /^[0-9a-f]{64}$/);
    const before = keptNames(w).length;
    run(w, "install");
    assert.equal(keptNames(w).length, before, "once fingerprinted, the next reinstall moves nothing");
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

// PARTIAL FAILURE: the keep move is refused (a planted kept-skills link, #101). The changed dir stays where it is, the
// unchanged one is still removed, the record is kept so the uninstall can be re-run, the human-readable note says why,
// and the run exits non-zero.
test("uninstall: a refused keep move leaves the changed dir in place and keeps the record", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    replaceWithMine(w);
    const outside = join(w.home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, keptDir(w));
    const r = spawnSync(process.execPath, [join(ROOT, "dist", "install-claude.js"), "uninstall", "wicked-bus", "--claude-home", w.cfg, "--json"], { encoding: "utf8", env: { HOME: w.home, USERPROFILE: w.home, PATH: "/usr/bin:/bin", NO_COLOR: "1" }, timeout: 60_000 });
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(readFileSync(join(w.emit, "SKILL.md"), "utf8"), MINE, "the changed dir is left in place");
    assert.deepEqual(readdirSync(outside), [], "nothing moved through the link");
    const rep = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
    const act = rep.actions.find((a) => a.target === "skills/wicked-bus-emit");
    assert.equal(act.result, "failed", JSON.stringify(rep.actions));
    assert.ok(rep.notes.some((n) => /^skills\/wicked-bus-emit not moved \(.*kept-skills: is a symlink.*\); the dir is left in place$/.test(n)), JSON.stringify(rep.notes));
    assert.ok(JSON.parse(readFileSync(w.marker, "utf8")).products["wicked-bus"], "the record is kept for a re-run");
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

// codex r1 (W12, compatibility): the published marker schema declares every key a dir/file record carries.
test("a real marker's dir and file records use only keys the published marker schema declares", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "install-marker.schema.json"), "utf8"));
    const findRecordSchema = (node) => {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node.oneOf)) {
        const hit = node.oneOf.find((o) => o?.properties?.kind?.enum?.includes?.("dir"));
        if (hit) return hit;
      }
      for (const v of Object.values(node)) {
        const found = findRecordSchema(v);
        if (found) return found;
      }
      return undefined;
    };
    const rec = findRecordSchema(schema);
    assert.ok(rec && rec.additionalProperties === false, "the dir/file record schema is closed");
    const declared = Object.keys(rec.properties);
    const files = JSON.parse(readFileSync(w.marker, "utf8")).products["wicked-bus"].files.filter((f) => f.kind === "dir" || f.kind === "file");
    assert.ok(files.length > 0);
    for (const f of files) {
      for (const key of Object.keys(f)) assert.ok(declared.includes(key), `${key} on ${f.path} is not declared by the schema (${declared.join(", ")})`);
      if (f.sha256 !== undefined) assert.match(f.sha256, new RegExp(rec.properties.sha256.pattern));
    }
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

// codex r1 (W10): --force takes over a dir another product records. That record is a pathname too: a changed dir is
// moved to kept-skills before the takeover, and an unchanged one is replaced as before.
test("--force keeps a changed dir recorded to another product, and replaces the unchanged one", { skip }, () => {
  const w = world();
  try {
    run(w, "install");
    const m = JSON.parse(readFileSync(w.marker, "utf8"));
    m.products["wicked-other"] = m.products["wicked-bus"]; // the same real records, now owned by another product
    delete m.products["wicked-bus"];
    writeFileSync(w.marker, JSON.stringify(m, null, 2));
    replaceWithMine(w);
    const r = spawnSync(process.execPath, [join(ROOT, "dist", "install-claude.js"), "wicked-bus", "--force", "--skip-binaries", "--source-root", w.src, "--claude-home", w.cfg, "--json"], { encoding: "utf8", env: { HOME: w.home, USERPROFILE: w.home, PATH: "/usr/bin:/bin", NO_COLOR: "1" }, timeout: 60_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const kept = keptNames(w);
    assert.equal(kept.length, 1, `the person's dir was deleted by the takeover: ${kept.join(", ")}`);
    assert.equal(readFileSync(join(keptDir(w), kept[0], "SKILL.md"), "utf8"), MINE);
    const rep = JSON.parse(r.stdout).reports.find((e) => e.productId === "wicked-bus");
    const moved = rep.actions.filter((a) => a.kind === "collision-moved");
    assert.deepEqual(moved.map((a) => a.target), ["skills/wicked-bus-emit"]);
    assert.match(moved[0].detail, /recorded to wicked-other that changed since it was written/);
    assert.equal(rep.actions.filter((a) => a.kind === "collision-skipped" && /ownership transferred from wicked-other/.test(a.detail)).length, 2);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});
