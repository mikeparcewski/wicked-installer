// BC-74 (F-W1-102): resolving the quick-start bundle — and a bare `install wicked-crew` — must pull
// wicked-garden, so the default install never boots a daemon that refuses every launch under the
// `require` base-skill policy. The dependency is `crew.requires: ["wicked-garden"]`; this exercises
// the resolver that walks it (dist/, like product-detection.test.mjs — CI builds before test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const { resolve } = await import(join(root, "dist", "resolver.js"));

const idsOf = (r) => new Set([...r.selected, ...r.added].map((p) => p.id));

test("the quick-start bundle resolves to BOTH wicked-crew and wicked-garden", () => {
  const qs = registry.bundles.find((b) => b.id === "quick-start");
  const r = resolve(qs.products);
  const ids = idsOf(r);
  assert.equal(r.blocked.length, 0, `nothing blocked: ${r.blocked.join(",")}`);
  assert.ok(ids.has("wicked-crew"), "crew is in the quick-start plan");
  assert.ok(ids.has("wicked-garden"), "garden is pulled in (via crew.requires) — the default install grounds the daemon");
});

test("a bare `install wicked-crew` also pulls wicked-garden (the dependency is on crew, not the bundle)", () => {
  const ids = idsOf(resolve(["wicked-crew"]));
  assert.ok(ids.has("wicked-crew") && ids.has("wicked-garden"), "the most common path grounds too");
});
