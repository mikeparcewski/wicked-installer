import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));

/**
 * `--all` must never install a RETIRED product.
 *
 * wicked-testing and wicked-brain are both npm-DEPRECATED. The registry marks them
 * `status: "retired"` and `listProducts()` excluded them, but the two `--all` paths carried
 * their own copy of the predicate filtering only `design` — so `--all` installed both.
 * The duplication was the bug; this pins the outcome rather than the spelling.
 */
test("the registry still marks the retired products as retired", () => {
  const byId = Object.fromEntries(registry.products.map((p) => [p.id, p]));
  for (const id of ["wicked-testing", "wicked-brain"]) {
    assert.equal(byId[id]?.status, "retired", `${id} must stay marked retired`);
  }
});

test("no --all path filters on `design` alone", () => {
  // A structural pin: the drifted copies are what shipped the bug, so the shape itself is
  // what must not come back.
  for (const f of ["src/install-claude.ts", "src/install-antigravity.ts", "src/registry.ts"]) {
    const src = readFileSync(join(root, f), "utf8");
    assert.ok(
      !/status\s*!==\s*"design"(?!\s*&&)/.test(src.replace(/isInstallable[\s\S]*?\n/g, "")),
      `${f} filters on "design" alone — retired products would pass`,
    );
  }
});

test("every non-retired product is installable, and no retired one is", async () => {
  // dist is what ships (package.json files[] is ["dist/", ...]), so assert the BUILT artifact —
  // a predicate that is right in src and missing from dist would still ship the bug.
  const { isInstallable } = await import("../dist/types.js");
  for (const p of registry.products) {
    assert.equal(
      isInstallable(p),
      p.status !== "design" && p.status !== "retired",
      `${p.id} (${p.status})`,
    );
  }
});
