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

test("wicked-core is a manual entry that rides wicked-crew — never installed on its own, in no bundle (wicked-core #405)", () => {
  const core = registry.products.find((p) => p.id === "wicked-core");
  assert.ok(core, "wicked-core must be in the registry — the hook binary ships inside crew's core-ts platform package");
  assert.equal(core.install.type, "manual", "nothing installs wicked-core directly: it arrives inside wicked-core-ts");
  assert.deepEqual(core.requires, ["wicked-crew"], "installed exactly when wicked-crew is (the detector's manual arm)");
  assert.equal(core.standalone, false);
  assert.equal(core.status, "active");
  for (const b of registry.bundles) {
    assert.ok(!b.products.includes("wicked-core"), `bundle ${b.id} must not list wicked-core — crew brings it`);
  }
});

test("crew daemon needs its backend and uv for the job skills environment (B1)", () => {
  const daemon = byId["wicked-crew"].capabilities.find((c) => c.id === "daemon");
  assert.deepEqual(daemon.needs, [
    { kind: "backend", bin: "wicked-crew", npx: "wicked-crew" },
    { kind: "uv" },
    { kind: "backend", bin: "wicked-estate", product: "wicked-estate" },
    { kind: "crew-garden" },
  ]);
});

test("wicked-crew requires wicked-garden — expressed ONCE, not also in recommended (BC-74, F-W1-102)", () => {
  // A crew-only install boots a daemon that refuses every launch under the default `require`
  // base-skill policy until garden's skills are present (F-W1-102; crew #605 surfaces the warning).
  // The dependency is a property of crew, so it lives on crew.requires — every path that installs
  // crew (quick-start, creative, `install wicked-crew`, full) gets garden. Expressing it on the
  // quick-start bundle instead would fix one path and leave `install wicked-crew` broken.
  const crew = byId["wicked-crew"];
  assert.deepEqual(crew.requires, ["wicked-garden", "wicked-estate"], "crew hard-requires garden for the default policy, and estate to add a repository");
  assert.ok(!(crew.recommended ?? []).includes("wicked-garden"), "garden is a requirement now, not also a recommendation — once");
  // quick-start does NOT list garden directly: it arrives through crew.requires (one place).
  const qs = registry.bundles.find((b) => b.id === "quick-start");
  assert.ok(!qs.products.includes("wicked-garden"), "quick-start pulls garden via crew.requires, never a second listing");
  assert.match(qs.description, /wicked-crew serve/, "the quick-start description names the post-install next step");
  assert.match(qs.description, /http:\/\/127\.0\.0\.1:7701/, "and where Studio opens");
  assert.ok(!qs.products.includes("wicked-estate"), "estate arrives through crew.requires too, never a second listing");
});

test("first-run B2: wicked-crew requires wicked-estate, which is not called optional for crew", () => {
  // Adding a repository in Studio indexes it with wicked-estate (the onboarding workflow's
  // `index` phase), so a crew install without estate failed at its first repository.
  const crew = byId["wicked-crew"];
  assert.ok(crew.requires.includes("wicked-estate"), "estate is a requirement of crew");
  assert.ok(!(crew.recommended ?? []).includes("wicked-estate"), "a requirement, not also a recommendation");
  const daemon = crew.capabilities.find((c) => c.id === "daemon");
  assert.ok(daemon.needs.some((n) => n.bin === "wicked-estate" && n.product === "wicked-estate"), "crew's readiness checks estate");
  assert.notEqual(daemon.optional, true, "the daemon capability is required");
  assert.doesNotMatch(byId["wicked-estate"].install.mcpInstructions, /optional/i);
});

test("release-1104 descriptions: estate's real tool and language counts, studio is the ADE with Apps, crew's review is a default", () => {
  const estate = byId["wicked-estate"].description;
  assert.match(estate, /33 MCP tools/, "estate's MCP server lists 33 tools (wicked-estate README, MCP section)");
  assert.match(estate, /114 languages/, "the language count is wicked-estate's languages.toml");
  assert.doesNotMatch(estate, /\b(29|30) tools|one binary/, "estate ships two executables, the CLI and the MCP server");
  assert.match(estate, /never their rows/);
  const studio = byId["wicked-studio"].description;
  assert.match(studio, /^The ADE \(agentic development environment\)/);
  assert.match(studio, /apps and dashboards over your databases/);
  assert.match(studio, /Knowledge map/);
  assert.doesNotMatch(studio, /browser console/);
  const crew = byId["wicked-crew"].description;
  assert.match(crew, /By default a different agent reviews the work; when none can, the job stops unless you launch it as reduced assurance/);
  assert.match(crew, /agents read your databases only through one read-only gate/, "the gate governs databases; API and MCP tools reach agents as MCP tools");
  assert.doesNotMatch(crew, /Evaluator is never the creator|never asserted/, "a reduced-assurance job can be reviewed by its creator's seat, labelled");
  assert.match(crew, /a change asked for in a chat is built, checked and reviewed by a different agent/, "only chat changes are reviewed; direct edits and undo are the person's own");
  // the README's product table says the same, row by row
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const row = (id) => readme.split("\n").find((l) => l.startsWith(`| [${id}](`)) ?? "";
  assert.match(row("wicked-estate"), /114 languages[^|]*33 MCP tools[^|]*never their rows/);
  assert.match(row("wicked-studio"), /^\| \[wicked-studio\][^|]*\| active \| The ADE \(agentic development environment\)[^|]*Apps over your databases[^|]*Ask a question of your data[^|]*Knowledge map/);
  assert.match(row("wicked-crew"), /by default a different agent reviews the work[^|]*your databases only through one read-only gate/);
  assert.match(row("wicked-core"), /core-ts >= 0\.15\.25/);
  assert.doesNotMatch(readme, /29 tools|103 languages|Browser console for wicked-crew|evidence-re-derived "done"|core-ts >= 0\.7\.26/);
});

test("public copy says job, not run, and Wicked Studio, not a console", () => {
  const text = JSON.stringify(registry) + readFileSync(join(root, "README.md"), "utf8");
  assert.doesNotMatch(text, /launch a run|first run in|governed-run daemon|Studio console/);
});
