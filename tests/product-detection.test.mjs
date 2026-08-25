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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const { isProductInstalled } = await import(join(root, "dist", "detector.js"));

test("every registry product gets a real answer, not a default-false", async () => {
  // The regression was structural: unknown id ⇒ false. If detection is derived from the install
  // spec, then every product in the registry is reachable by some branch. We prove that by
  // checking the SOURCE has no blanket default for known products, and that each id resolves
  // without throwing.
  for (const p of registry.products) {
    assert.doesNotThrow(
      () => isProductInstalled(p.id),
      `isProductInstalled(${p.id}) threw — every registry id must resolve`,
    );
    assert.equal(typeof isProductInstalled(p.id), "boolean", `${p.id} must answer a boolean`);
  }
});

test("detection is derived from the install spec, so a new product needs no new branch", () => {
  const src = readFileSync(join(root, "src", "detector.ts"), "utf8");
  // The default arm must delegate, not answer false.
  assert.match(
    src,
    /default:\s*\n\s*return installedPerRegistry\(productId\);/,
    "isProductInstalled's default arm must delegate to the registry-derived check",
  );
  // And that helper must branch on install.type, i.e. read the registry rather than hardcode ids.
  assert.match(src, /function installedPerRegistry/, "the registry-derived helper must exist");
  assert.match(src, /switch \(install\.type\)/, "detection must branch on the product's install.type");
});

test("a retired product is not 'installed' merely because its data survives", () => {
  // ~/.wicked-brain is a FROZEN ARCHIVE that must never be deleted. Reporting brain as installed
  // because that directory exists tells an operator to uninstall something that is not installed.
  const src = readFileSync(join(root, "src", "detector.ts"), "utf8");
  const brainArm = src.slice(src.indexOf('case "wicked-brain"'), src.indexOf('default:'));
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
