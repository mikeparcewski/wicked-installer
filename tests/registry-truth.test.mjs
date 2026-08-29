import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const byId = Object.fromEntries(registry.products.map((p) => [p.id, p]));

/*
 * Registry truth pass (recon-2026-08 docs-R3 / DT-2). Five defects made the
 * family's primary CTA deliver incomplete or broken installs; these pins keep
 * them fixed:
 *  (a) estate installed only the MCP crate — no indexing CLI, so the MCP
 *      instructions presupposed a graph that could never exist;
 *  (b) wicked-vault had no entry while garden's setup blocks without it;
 *  (c) garden required wicked-bus (opt-in per garden's own docs) instead of vault;
 *  (d) garden's post-install pointed at /wicked-garden:setup — a command that
 *      does not exist (the real skill invocation is /wicked-garden-core setup);
 *  (e) the bus description said "poll-based" — stale since the 2.x
 *      push-over-durable-poll daemon.
 */

test("estate installs BOTH crates: the indexing CLI and the MCP server", () => {
  const estate = byId["wicked-estate"];
  assert.ok(estate, "wicked-estate must be in the registry");
  assert.deepEqual(
    estate.install.crates,
    ["wicked-estate", "wicked-estate-mcp"],
    "one crate without the other is a broken install (index-less MCP, or MCP-less index)",
  );
  // `crate` stays the primary/MCP binary name — registration, detection, and
  // uninstall helpers key on it.
  assert.equal(estate.install.crate, "wicked-estate-mcp");
});

test("wicked-vault is a dependency-shaped row, not a marketed product", () => {
  const vault = byId["wicked-vault"];
  assert.ok(vault, "wicked-vault must be in the registry — garden's requires cannot resolve without it");
  assert.equal(vault.standalone, false, "vault is an internal package (root CLAUDE.md); a product-shaped entry would re-productize it");
  assert.equal(vault.install.type, "npm-global");
  assert.equal(vault.install.package, "wicked-vault");
  // And it must never be marketed through a bundle — it arrives via `requires` only.
  for (const b of registry.bundles) {
    assert.ok(!b.products.includes("wicked-vault"), `bundle ${b.id} must not list wicked-vault directly`);
  }
});

test("garden requires vault (the gate's backend); bus is recommended, not required", () => {
  const garden = byId["wicked-garden"];
  assert.deepEqual(garden.requires, ["wicked-vault"], "garden setup blocks without vault; nothing else is a hard dep");
  assert.ok(!garden.requires.includes("wicked-bus"), "bus is opt-in per garden's own docs — requiring it blocks the garden flow needlessly");
  assert.ok(garden.recommended.includes("wicked-bus"), "bus stays visible as a recommendation");
});

test("garden's post-install names a command that exists", () => {
  const note = byId["wicked-garden"].install.mcpInstructions;
  assert.match(note, /\/wicked-garden-core setup/, "the setup action lives on the wicked-garden-core skill");
  assert.doesNotMatch(note, /\/wicked-garden:setup/, "/wicked-garden:setup does not exist");
});

test("bus description carries no stale delivery-model claim", () => {
  const bus = byId["wicked-bus"];
  assert.doesNotMatch(bus.description, /poll-based/, "the 2.x daemon is push-over-durable-poll");
  // "no network transport" is still true (single-host Unix-socket push) — keep it.
  assert.match(bus.description, /no network transport/);
});
