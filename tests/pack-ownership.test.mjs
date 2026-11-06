// pack-ownership.test.mjs — wicked-installer#48: `pack add` / `pack remove` never lose a user's files.
//
// Policy (C1): a local edit or a same-named skill this pack does not own HOLDS the update before
// anything changes; a clean update repairs missing owned files and prunes only unchanged obsolete
// ones; remove keeps and reports edited/foreign files and says cleanup is incomplete; skills go to
// the ACTIVE Claude config dir (CLAUDE_CONFIG_DIR). Network-free (garden stub), isolated temp HOMEs.
// Requires `npm run build` first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "index.js");
const STUB = join(__dirname, "garden-stub.mjs");

function runPack(args, { home, stubLog, stubExit, configDir }) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WICKED_GARDEN_BIN: STUB,
    GARDEN_STUB_LOG: stubLog ?? "",
    GARDEN_STUB_EXIT: String(stubExit ?? 0),
  };
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const r = spawnSync(process.execPath, [CLI, "pack", ...args], { encoding: "utf8", env });
  r.out = `${r.stdout}${r.stderr}`;
  return r;
}

function calls(log) {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** A pack dir: version + { "<skill>/<file>": content }. */
function makePack(root, version, files) {
  const dir = join(root, `pack-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wicked-pack.json"), JSON.stringify({
    spec: 1, name: "acme-mini", vendor: "acme", version, skills_dir: "skills", domains: [{ name: "mini" }],
  }));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, "skills", ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

const V1 = {
  "acme-mini/SKILL.md": "---\nname: acme-mini\ndescription: v1\n---\nv1 body\n",
  "acme-mini/ref/guide.md": "guide v1\n",
  "acme-mini-widget-maker/SKILL.md": "---\nname: acme-mini-widget-maker\ndescription: v1\n---\n",
};
// v2: SKILL.md changes, guide.md dropped, widget-maker renamed to widget-builder, a new file.
const V2 = {
  "acme-mini/SKILL.md": "---\nname: acme-mini\ndescription: v2\n---\nv2 body\n",
  "acme-mini/ref/new.md": "new in v2\n",
  "acme-mini-widget-builder/SKILL.md": "---\nname: acme-mini-widget-builder\ndescription: v2\n---\n",
};

function sandbox() {
  chmodSync(STUB, 0o755);
  const root = mkdtempSync(join(tmpdir(), "wicked-pack-own-"));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home, log: join(root, "stub.log"), skills: join(home, ".claude", "skills"), canonical: join(home, ".something-wicked", "wicked-garden", "packs", "installed", "acme-mini") };
}

test("#48: an edited installed skill HOLDS the upgrade — the edit survives, nothing changes, nothing registers", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    const v2 = makePack(sb.root, "0.2.0", V2);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    const skill = join(sb.skills, "acme-mini", "SKILL.md");
    writeFileSync(skill, "MY EDIT\n");
    const before = calls(sb.log).length;

    const r = runPack(["add", v2], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /HELD: the update of acme-mini 0\.1\.0 → 0\.2\.0 is held/);
    assert.match(r.out, /edited\s+acme-mini\/SKILL\.md/);
    assert.equal(readFileSync(skill, "utf8"), "MY EDIT\n", "the user's edit is kept byte-for-byte");
    assert.ok(existsSync(join(sb.skills, "acme-mini-widget-maker", "SKILL.md")), "the rest of v1 stays as it was");
    assert.ok(existsSync(join(sb.skills, "acme-mini", "ref", "guide.md")));
    assert.ok(!existsSync(join(sb.skills, "acme-mini-widget-builder")), "nothing of v2 was written");
    assert.match(readFileSync(join(sb.canonical, "wicked-pack.json"), "utf8"), /"0\.1\.0"/, "the canonical copy is still v1");
    assert.deepEqual(calls(sb.log).slice(before).map((c) => c[1]), ["check"], "no register after a hold");

    // A re-add of the SAME version is held too (it would have replaced the edit).
    const again = runPack(["add", v1], { home: sb.home, stubLog: sb.log });
    assert.equal(again.status, 1, again.out);
    assert.equal(readFileSync(skill, "utf8"), "MY EDIT\n");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a file the user added inside an installed skill HOLDS a re-add and survives", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    const mine = join(sb.skills, "acme-mini", "my-notes.md");
    writeFileSync(mine, "notes\n");
    const r = runPack(["add", v1], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /added\s+acme-mini\/my-notes\.md/);
    assert.equal(readFileSync(mine, "utf8"), "notes\n");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a user's own same-named skill HOLDS the install, and pack remove never deletes it", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    const own = join(sb.skills, "acme-mini");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "my own skill with the same name\n");

    const r = runPack(["add", v1], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /HELD: the install of acme-mini 0\.1\.0 is held/);
    assert.match(r.out, /foreign\s+acme-mini\//);
    assert.equal(readFileSync(join(own, "SKILL.md"), "utf8"), "my own skill with the same name\n");
    assert.ok(!existsSync(sb.canonical), "nothing installed");

    const rm = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log });
    assert.equal(rm.status, 0, rm.out);
    assert.equal(readFileSync(join(own, "SKILL.md"), "utf8"), "my own skill with the same name\n", "remove leaves the user's skill");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a clean upgrade repairs missing owned files, prunes unchanged obsolete ones, and records the new version", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    const v2 = makePack(sb.root, "0.2.0", V2);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    // The user deletes an owned file that v2 still ships (missing → repaired).
    unlinkSync(join(sb.skills, "acme-mini", "SKILL.md"));

    const dry = runPack(["add", v2, "--dry-run"], { home: sb.home, stubLog: sb.log });
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /missing\s+acme-mini\/SKILL\.md/);
    assert.match(dry.out, /obsolete\s+acme-mini\/ref\/guide\.md/);
    assert.match(dry.out, /obsolete\s+acme-mini-widget-maker\/SKILL\.md/);
    assert.match(dry.out, /new\s+acme-mini-widget-builder\/SKILL\.md/);
    assert.ok(!existsSync(join(sb.skills, "acme-mini", "SKILL.md")), "dry-run writes nothing");

    const r = runPack(["add", v2], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "SKILL.md"), "utf8"), V2["acme-mini/SKILL.md"], "repaired with v2's bytes");
    assert.ok(existsSync(join(sb.skills, "acme-mini", "ref", "new.md")));
    assert.ok(!existsSync(join(sb.skills, "acme-mini", "ref", "guide.md")), "unchanged obsolete file pruned");
    assert.ok(!existsSync(join(sb.skills, "acme-mini-widget-maker")), "unchanged obsolete skill dir pruned");
    assert.ok(existsSync(join(sb.skills, "acme-mini-widget-builder", "SKILL.md")));
    const record = JSON.parse(readFileSync(join(sb.home, ".claude", "wicked-installer", "packs", "acme-mini.json"), "utf8"));
    assert.equal(record.version, "0.2.0");
    assert.equal(record.pending, undefined, "no in-flight journal left behind");
    assert.deepEqual(record.skills, ["acme-mini", "acme-mini-widget-builder"]);
    assert.match(record.files["acme-mini/SKILL.md"], /^[0-9a-f]{64}$/);
    assert.equal(record.skillsRoot, sb.skills);
    assert.ok(record.installId && record.source);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: an obsolete owned file the user edited HOLDS the upgrade (kept, not pruned)", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    const v2 = makePack(sb.root, "0.2.0", V2);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    const guide = join(sb.skills, "acme-mini", "ref", "guide.md");
    writeFileSync(guide, "my guide edits\n");
    const r = runPack(["add", v2], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /edited\s+acme-mini\/ref\/guide\.md\s+\(no longer shipped, but locally edited\)/);
    assert.equal(readFileSync(guide, "utf8"), "my guide edits\n");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: skills go to CLAUDE_CONFIG_DIR when it is set, never to ~/.claude", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    const cfg = join(sb.root, "alt-claude");
    const r = runPack(["add", v1], { home: sb.home, stubLog: sb.log, configDir: cfg });
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(cfg, "skills", "acme-mini", "SKILL.md")), "the active config dir gets the skills");
    assert.ok(existsSync(join(cfg, "wicked-installer", "packs", "acme-mini.json")), "and the record");
    assert.ok(!existsSync(join(sb.home, ".claude")), "~/.claude is not touched");
    const rm = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log, configDir: cfg });
    assert.equal(rm.status, 0, rm.out);
    assert.ok(!existsSync(join(cfg, "skills", "acme-mini")));
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: pack remove keeps and reports edited and foreign files and says cleanup is INCOMPLETE", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    writeFileSync(join(sb.skills, "acme-mini", "SKILL.md"), "MY EDIT\n");
    writeFileSync(join(sb.skills, "acme-mini", "mine.md"), "mine\n");
    const r = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Cleanup INCOMPLETE for acme-mini: kept 2 path\(s\)/);
    assert.match(r.out, /SKILL\.md \(edited\)/);
    assert.match(r.out, /mine\.md \(not written by this pack\)/);
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "SKILL.md"), "utf8"), "MY EDIT\n");
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "mine.md"), "utf8"), "mine\n");
    assert.ok(!existsSync(join(sb.skills, "acme-mini", "ref", "guide.md")), "unchanged owned files are removed");
    assert.ok(!existsSync(join(sb.skills, "acme-mini-widget-maker")), "an unchanged skill is removed whole");
    assert.deepEqual(calls(sb.log).at(-1), ["pack", "unregister", "acme-mini"], "still unregistered");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: an install from before records (0.8.1) is adopted when unchanged, and held when edited", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    const v2 = makePack(sb.root, "0.2.0", V2);
    // What 0.8.1 left: the canonical copy + plain copies of its skills, no record.
    const legacy = () => {
      rmSync(join(sb.home, ".claude"), { recursive: true, force: true });
      rmSync(sb.canonical, { recursive: true, force: true });
      cpSync(v1, sb.canonical, { recursive: true });
      mkdirSync(sb.skills, { recursive: true });
      cpSync(join(v1, "skills", "acme-mini"), join(sb.skills, "acme-mini"), { recursive: true });
      cpSync(join(v1, "skills", "acme-mini-widget-maker"), join(sb.skills, "acme-mini-widget-maker"), { recursive: true });
    };
    legacy();
    const ok = runPack(["add", v2], { home: sb.home, stubLog: sb.log });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /adopted/);
    assert.ok(!existsSync(join(sb.skills, "acme-mini-widget-maker")), "the unchanged legacy obsolete skill is pruned");
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "SKILL.md"), "utf8"), V2["acme-mini/SKILL.md"]);

    legacy();
    writeFileSync(join(sb.skills, "acme-mini", "SKILL.md"), "edited under 0.8.1\n");
    const held = runPack(["add", v2], { home: sb.home, stubLog: sb.log });
    assert.equal(held.status, 1, held.out);
    assert.match(held.out, /foreign\s+acme-mini\//);
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "SKILL.md"), "utf8"), "edited under 0.8.1\n");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a failed registration is recoverable — a re-run converges and registers", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    // check passes, register fails: the stub exits 1 for every call, so use --force for the gate.
    const r = runPack(["add", v1, "--force"], { home: sb.home, stubLog: sb.log, stubExit: 1 });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /registration failed .* Re-run/);
    const again = runPack(["add", v1], { home: sb.home, stubLog: sb.log });
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /\d+ unchanged/);
    assert.equal(calls(sb.log).at(-1)[1], "register");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: identical bytes are not ownership — a user's own copy of the pack's skill is held on a first install and never removed", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    // The user copied the pack's skill in by hand, byte for byte, before ever running pack add.
    cpSync(join(v1, "skills", "acme-mini"), join(sb.skills, "acme-mini"), { recursive: true });
    const r = runPack(["add", v1], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /foreign\s+acme-mini\/\s+\(exists and was not installed by this pack\)/);
    const rm = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log });
    assert.equal(rm.status, 0, rm.out);
    assert.ok(existsSync(join(sb.skills, "acme-mini", "SKILL.md")), "the user's copy survives remove");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a pre-record install is never assumed in a CLAUDE_CONFIG_DIR it did not write to (remove keeps that dir's same-named skill)", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    // 0.8.1 left a canonical copy; the active config dir is elsewhere and holds the user's own skills.
    cpSync(v1, sb.canonical, { recursive: true });
    const cfg = join(sb.root, "alt");
    cpSync(join(v1, "skills", "acme-mini"), join(cfg, "skills", "acme-mini"), { recursive: true });
    writeFileSync(join(cfg, "skills", "acme-mini", "extra.md"), "mine\n");
    const rm = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log, configDir: cfg });
    assert.equal(rm.status, 0, rm.out);
    assert.ok(existsSync(join(cfg, "skills", "acme-mini", "SKILL.md")), "nothing removed in a dir the old installer never used");
    assert.ok(existsSync(join(cfg, "skills", "acme-mini", "extra.md")));
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: remove never follows a link on an owned file's path (the link target's identical file survives)", { skip: process.platform === "win32" }, () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    // The user swaps the owned ref/ dir for a link to their own reference dir holding the same bytes.
    const external = join(sb.root, "my-refs");
    mkdirSync(external);
    writeFileSync(join(external, "guide.md"), V1["acme-mini/ref/guide.md"]);
    rmSync(join(sb.skills, "acme-mini", "ref"), { recursive: true });
    symlinkSync(external, join(sb.skills, "acme-mini", "ref"));
    const rm = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log });
    assert.equal(rm.status, 1, rm.out);
    assert.match(rm.out, /Cleanup INCOMPLETE/);
    assert.equal(readFileSync(join(external, "guide.md"), "utf8"), V1["acme-mini/ref/guide.md"], "the file behind the link is untouched");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a clean update where a file becomes a directory (and a case-only rename) lands, and the canonical copy moves last", () => {
  const sb = sandbox();
  try {
    const a = makePack(sb.root, "1.0.0", { "acme-mini/SKILL.md": "s\n", "acme-mini/ref": "a file named ref\n", "acme-mini/Guide.md": "g\n" });
    const b = makePack(sb.root, "2.0.0", { "acme-mini/SKILL.md": "s\n", "acme-mini/ref/new.md": "now a dir\n", "acme-mini/guide.md": "g2\n" });
    assert.equal(runPack(["add", a], { home: sb.home, stubLog: sb.log }).status, 0);
    const r = runPack(["add", b], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "ref", "new.md"), "utf8"), "now a dir\n");
    assert.equal(readFileSync(join(sb.skills, "acme-mini", "guide.md"), "utf8"), "g2\n", "the renamed file is present (case-insensitive filesystems included)");
    assert.match(readFileSync(join(sb.canonical, "wicked-pack.json"), "utf8"), /"2\.0\.0"/);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("#48: a malformed record holds the update and keeps everything (nothing it names is trusted)", () => {
  const sb = sandbox();
  try {
    const v1 = makePack(sb.root, "0.1.0", V1);
    assert.equal(runPack(["add", v1], { home: sb.home, stubLog: sb.log }).status, 0);
    const rec = join(sb.home, ".claude", "wicked-installer", "packs", "acme-mini.json");
    writeFileSync(rec, JSON.stringify({ schema: 1, skills: ["acme-mini"], files: { "../../escape/x": "0".repeat(64) } }));
    const r = runPack(["add", v1], { home: sb.home, stubLog: sb.log });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /record unreadable: .*unsafe path/);
    writeFileSync(rec, JSON.stringify({ schema: 1, skills: [], files: null }));
    const rm = runPack(["remove", "acme-mini"], { home: sb.home, stubLog: sb.log });
    assert.equal(rm.status, 1, rm.out);
    assert.match(rm.out, /record unreadable: .*nothing there was removed/);
    assert.ok(existsSync(join(sb.skills, "acme-mini", "SKILL.md")));
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});
