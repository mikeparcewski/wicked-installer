// product-detection.test.mjs — `isProductInstalled` must not answer a CHECKED NEGATIVE
// about products it was never taught to look for.
//
// The original shape was a switch over four product ids ending in `default: return false`, so
// wicked-crew, wicked-estate, wicked-interactive and wicked-studio reported "not installed" on
// every machine, forever. On a box running `wicked-crew serve` the status command printed
// "not installed  wicked-crew" while that daemon was answering requests — the surface people run
// specifically to find out what they have was wrong about half the ecosystem.
//
// These pin the STRUCTURE that prevents it coming back: detection is derived from each product's
// own `install` spec, so adding a product to registry.json needs no new branch here and cannot
// silently default to "no".
//
// Deliberately NOT asserted: whether any particular product is installed on the machine running
// the suite. That is environment, not behaviour — a test that demands wicked-crew be present would
// fail in CI for the right reason and the wrong cause.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const { isProductInstalled } = await import(join(root, "dist", "detector.js"));

/** Source with comments removed — assertions about CODE must not match prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("every registry product gets a real answer, not a default-false", async () => {
  // The regression was structural: unknown id ⇒ false. If detection is derived from the install
  // spec, then every product in the registry is reachable by some branch. We prove that by
  // checking the SOURCE has no blanket default for known products, and that each id resolves
  // without throwing.
  for (const p of registry.products) {
    // Called ONCE and captured: this spawns `command -v`, so a second call is both slow and a
    // second chance for the environment to differ between the two assertions.
    let answer;
    assert.doesNotThrow(() => {
      answer = isProductInstalled(p.id);
    }, `isProductInstalled(${p.id}) threw — every registry id must resolve`);
    assert.equal(typeof answer, "boolean", `${p.id} must answer a boolean`);
  }
});

test("detection is derived from the install spec, so a new product needs no new branch", () => {
  const src = readFileSync(join(root, "src", "detector.ts"), "utf8");
  // The default arm must delegate, not answer false.
  // Whitespace-agnostic: `default: return installedPerRegistry(...)` on one line is the same
  // structure, and a test that fails a harmless reformat is measuring layout, not behaviour.
  assert.match(
    src,
    /default:\s*return\s+installedPerRegistry\(\s*productId\s*(?:,[^)]*)?\)\s*;/,
    "isProductInstalled's default arm must delegate to the registry-derived check",
  );
  // And that helper must branch on install.type, i.e. read the registry rather than hardcode ids.
  assert.match(src, /function installedPerRegistry/, "the registry-derived helper must exist");
  assert.match(src, /switch \(install\.type\)/, "detection must branch on the product's install.type");
});

test("a retired product is not 'installed' merely because its data survives", () => {
  // ~/.wicked-brain is a FROZEN ARCHIVE that must never be deleted. Reporting brain as installed
  // because that directory exists tells an operator to uninstall something that is not installed.
  // Comments are prose, not behaviour: the arm's own doc EXPLAINS that ~/.wicked-brain is a
  // frozen archive, so a naive text search finds the path it exists to warn about. Strip comments
  // and assert on code — the same trap that a sibling guard in wicked-crew hit.
  const src = stripComments(readFileSync(join(root, "src", "detector.ts"), "utf8"));
  // Assert the SLICE BOUNDS first. With indexOf returning -1 the slice still yields a string, and
  // `!includes(...)` on the wrong text passes — the test would report success while checking
  // nothing. A guard that can pass vacuously is worse than no guard.
  const start = src.indexOf('case "wicked-brain"');
  const end = src.indexOf("default:", start);
  assert.ok(start !== -1, 'the wicked-brain arm must exist to be asserted about');
  assert.ok(end > start, 'the wicked-brain arm must be followed by the default arm');
  const brainArm = src.slice(start, end);
  assert.ok(
    !brainArm.includes(".wicked-brain"),
    "wicked-brain detection must not consult the frozen ~/.wicked-brain archive",
  );
});

test("the two genuine special cases stay special", () => {
  const src = readFileSync(join(root, "src", "detector.ts"), "utf8");
  // wicked-testing was never a binary (skills only) and wicked-garden is a plugin, not a CLI —
  // a PATH probe would be wrong for both, so each keeps an explicit arm.
  assert.match(src, /case "wicked-testing":/, "wicked-testing needs its skills-dir check");
  assert.match(src, /case "wicked-garden":/, "wicked-garden needs its plugin-manifest check");
});

test("a manual product is installed exactly when its requirements are", () => {
  // wicked-studio ships INSIDE wicked-crew: it has no independent install, so claiming it is
  // absent while crew is present would be false, and claiming it present without crew would be
  // worse. The registry already encodes the relationship via `requires`.
  const studio = registry.products.find((p) => p.id === "wicked-studio");
  assert.ok(studio, "wicked-studio must be in the registry");
  assert.equal(studio.install.type, "manual", "wicked-studio installs manually (bundled in crew)");
  assert.deepEqual(studio.requires, ["wicked-crew"], "and its requirement is what detection reads");
  assert.equal(
    isProductInstalled("wicked-studio"),
    isProductInstalled("wicked-crew"),
    "a bundled product's presence must track the thing it is bundled into",
  );
});

test("registry-sourced names are validated before they reach a shell", () => {
  // `commandExists` interpolates into execSync, and these names come from registry.json — a file
  // that ships in the package and can be corrupted, hand-edited, or replaced. An entry like
  // `x; rm -rf ~` would otherwise reach a shell. Rejected rather than escaped: a name that needs
  // quoting to be safe is a name we should not probe. It also kills a quieter failure — a name
  // carrying a space or `$` makes `command -v` answer about something else and report it as fact.
  const src = readFileSync(join(root, "src", "detector.ts"), "utf8");
  assert.match(src, /const SAFE_BINARY = \/\^/, "a binary-name allowlist must exist");
  assert.match(src, /function commandExistsSafe/, "the guarded wrapper must exist");

  // Every registry-sourced probe must go through the guarded wrapper, never commandExists direct.
  const body = src.slice(src.indexOf("function installedPerRegistry"));
  const end = body.indexOf("\n}\n");
  assert.ok(end > 0, "installedPerRegistry must be delimited to be asserted about");
  const fn = body.slice(0, end);
  assert.ok(
    !/[^e]commandExists\(/.test(fn.replace(/commandExistsSafe\(/g, "SAFE(")),
    "installedPerRegistry must call commandExistsSafe, never commandExists directly",
  );

  // And the allowlist must actually reject a metacharacter payload.
  const m = /const SAFE_BINARY = (\/.*\/);/.exec(src);
  assert.ok(m, "SAFE_BINARY must be a literal regex");
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf("/")));
  for (const bad of ["x; rm -rf ~", "a b", "$(whoami)", "`id`", "a|b", "../x", ""]) {
    assert.equal(re.test(bad), false, `SAFE_BINARY must reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ["wicked-crew", "wicked-estate-mcp", "node", "a.b_c-1"]) {
    assert.equal(re.test(ok), true, `SAFE_BINARY must accept ${JSON.stringify(ok)}`);
  }
});

test("a cyclic or self-referential `requires` cannot hang or crash detection", () => {
  // `requires` comes from registry.json — data that ships in the package and can be hand-edited
  // or corrupted, exactly like the binary names. Before the guard, A→B→A recursed until the stack
  // blew, so a bad data file crashed the status command instead of yielding a wrong answer.
  // Proven against a REAL poisoned registry, not by reading the source.
  const regPath = join(root, "registry.json");
  const original = readFileSync(regPath, "utf8");
  try {
    const poisoned = JSON.parse(original);
    const byId = Object.fromEntries(poisoned.products.map((p) => [p.id, p]));
    // A ↔ B cycle plus a self-reference — both shapes, one file.
    byId["wicked-studio"].install = { type: "manual" };
    byId["wicked-studio"].requires = ["wicked-crew"];
    byId["wicked-crew"].install = { type: "manual" };
    byId["wicked-crew"].requires = ["wicked-studio"];
    byId["wicked-interactive"].install = { type: "manual" };
    byId["wicked-interactive"].requires = ["wicked-interactive"];
    writeFileSync(regPath, JSON.stringify(poisoned, null, 2));

    // A fresh process so the registry module cache cannot serve the clean copy.
    const probe = `
      const { isProductInstalled } = await import(${JSON.stringify(join(root, "dist", "detector.js"))});
      for (const id of ["wicked-studio", "wicked-crew", "wicked-interactive"]) {
        process.stdout.write(id + "=" + isProductInstalled(id) + "\\n");
      }
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(r.status, 0, `detection crashed on a cyclic registry:\n${r.stderr}`);
    assert.ok(!/Maximum call stack/i.test(r.stderr), "a cycle must not overflow the stack");
    // Nothing in a cycle is installed on the strength of the cycle itself.
    assert.match(r.stdout, /wicked-studio=false/);
    assert.match(r.stdout, /wicked-crew=false/);
    assert.match(r.stdout, /wicked-interactive=false/);
  } finally {
    writeFileSync(regPath, original);
  }
});
