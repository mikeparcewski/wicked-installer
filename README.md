```
 _      _            _ 
 __      _(_) ___| | _____  __| |
 \ \ /\ / / |/ __| |/ / _ \/ _` |
  \ V  V /| | (__|   <  __/ (_| |
   \_/\_/ |_|\___|_|\_\___|\__,_|

  _           _        _ _           
 (_)_ __  ___| |_ __ _| | | ___ _ __ 
 | | '_ \/ __| __/ _` | | |/ _ \ '__|
 | | | | \__ \ || (_| | | |  __/ |   
 |_|_| |_|___/\__\__,_|_|_|\___|_|
```

> Registry-driven installer for the wicked-\* AI developer ecosystem.

[![npm version](https://img.shields.io/npm/v/wicked-installer)](https://www.npmjs.com/package/wicked-installer)
[![license](https://img.shields.io/npm/l/wicked-installer)](LICENSE)

---

## Quick start

```
npx wicked-installer
```

Interactive TUI — pick a bundle or select products individually. Detects which AI coding CLIs you have installed and guides you from there.

---

## CLI

```
npx wicked-installer                 Interactive install
npx wicked-installer list            List available products
npx wicked-installer install <ids>   Install specific products (space-separated)
npx wicked-installer pack <verb>     Third-party skill packs (add/remove/list/check)
npx wicked-installer status          Show detected CLIs, installed products, and
                                     wicked-garden's Claude Code registration
npx wicked-installer --version

Flags:
  --dry-run              Print the exact plan (target dirs, commands) and run NOTHING
                         that writes — no npm/npx/cargo/git, no downloads, no copies
  --claude-home <dir>    Claude Code config dir to register wicked-garden into
                         (repeatable; default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  --source-root <dir>    Register wicked-garden from the local checkout
                         <dir>/wicked-garden instead of the published marketplace
  --force                Passed through to the per-CLI install scripts (interactive)
```

`install <ids>` resolves required dependencies first (garden pulls in wicked-vault),
installs each product directly, and exits 1 if any of them failed. With `--dry-run`
every product type prints its plan and nothing runs.

---

## wicked-garden is a registered Claude Code plugin

Claude Code only loads plugins it has **registered** — a marketplace entry plus an
install record whose payload lives in `<configDir>/plugins/cache/<marketplace>/<plugin>/<version>/`.
That cache is also the only place wicked-crew's skills discovery reads. A bare copy
under `~/.claude/plugins/wicked-garden/` (what `npx wicked-garden install` produces,
always into `~/.claude` whatever `CLAUDE_CONFIG_DIR` says) is loaded by nothing.

So when the `claude` CLI is present, `install wicked-garden` (and the interactive
zero-CLI path) resolves the active config dir(s) exactly like the Claude install
script does — `--claude-home` → `CLAUDE_CONFIG_DIR` (":"/","-separated, exclusive
when set) → `~/.claude` — and for **each** of them runs Claude Code's own mechanism
with `CLAUDE_CONFIG_DIR=<target>`:

```
claude plugin marketplace list --json                 # idempotent: add only when absent
claude plugin marketplace add mikeparcewski/wicked-garden
claude plugin list --json
claude plugin install wicked-garden@wicked-garden     # or: claude plugin update wicked-garden@wicked-garden
```

then verifies from disk that `<target>/plugins/cache/wicked-garden/wicked-garden/<version>/`
exists. A marketplace already registered from another source (say, a local checkout)
is kept as-is. `--source-root <dir>` registers `<dir>/wicked-garden` as the marketplace
instead of GitHub.

When Claude Code is **not** detected the installer falls back to `npx wicked-garden
install` and says so: *copied to ~/.claude/plugins/wicked-garden; not registered —
Claude Code not detected*.

`status` prints, per active config dir, the marketplace (and its source), the
installed version/scope, the cached versions, and flags a bare copy as
**copy only (unregistered)**. It reads the registration from disk and never
invokes the `claude` CLI (even `claude plugin list` writes `<configDir>/.claude.json`).

---

## Skill packs (the wicked-garden extension contract)

Third parties extend the wicked-garden catalog with **packs** — a
`wicked-pack.json` manifest plus a `skills/` tree following the
`{vendor}-{domain}` router / `{vendor}-{domain}-{role}` worker contract.
This command is the single acquisition path (garden's own
`npx wicked-garden pack install` delegates here):

```
npx wicked-installer pack add acme-seo-pack        # npm package spec
npx wicked-installer pack add ./acme-seo-pack      # local directory
npx wicked-installer pack remove acme-seo          # the MANIFEST name (wicked-pack.json "name"),
                                                   # not the npm spec — see `pack list`
npx wicked-installer pack list                     # what garden's runtime discovers
npx wicked-installer pack check ./acme-seo-pack    # conformance gate only
```

`pack add` fetches the source, runs wicked-garden's shipped conformance
gate (fail-closed; `--force` to override), copies the pack to
`~/.something-wicked/wicked-garden/packs/installed/<name>`, makes its
skills visible to **Claude Code** (`~/.claude/skills/` — or skips the copy
when the pack ships as a Claude Code plugin), and registers it with the
garden runtime (catalog + crew specialist routing + peer-floor probe).
Validation and registration are wicked-garden's own tooling — this command
never re-implements them.

**Honest scope note:** skill visibility for the *other* supported CLIs
(Codex, Antigravity, OpenCode, Pi) is not wired for packs yet; the per-CLI
install-script seam (INTERFACE.md) is where that lands. Provenance is
recorded (source URL + content hashes) but packs are **not signed** —
install only from sources you trust, as with any npm dependency.

Pack authoring guide: wicked-garden's `docs/extending.md`.

---

## Bundles

| Bundle | What it installs | Best for |
|---|---|---|
| `quick-start` | wicked-bus + wicked-crew | Fastest path to a governed multi-agent session — daemon up, Studio console open, first run in under five minutes |
| `garden` | wicked-bus + wicked-garden | Recommended starting point for Claude Code users — evidence-gated work, graph-aware refactoring, and the full 40-specialist QE domain |
| `knowledge` | wicked-bus + wicked-estate | Persistent memory, knowledge, and code-graph layer — everything else queries it |
| `creative` | wicked-interactive + wicked-crew | The document & render engine (HTML/PDF/PPTX), driven through Crew + the AI workflow console (Studio ships inside Crew) |
| `full` | wicked-bus + wicked-estate + wicked-garden + wicked-interactive + wicked-crew | The complete wicked-\* experience |

Required dependencies resolve automatically: wicked-garden requires **wicked-vault** (the evidence backend its gate re-derives against), so any selection containing garden also installs it.

---

## Products

| Product | Status | What it does |
|---|---|---|
| [wicked-estate](https://github.com/mikeparcewski/wicked-estate) | stable | MCP server: code graph + memory + knowledge in one binary. 29 tools across 3 domains. 103 languages. |
| [wicked-bus](https://www.npmjs.com/package/wicked-bus) | stable | Durable event fabric for agents — restart-durable at-least-once delivery with dead-lettering and replay. Zero infra (embedded SQLite), single-host. |
| [wicked-garden](https://github.com/mikeparcewski/wicked-garden) | active | Curated toolkit for what coding agents can't do alone. Claude Code plugin. Includes the 40-specialist QE domain (acceptance testing, evidence-gated, no self-grading). |
| [wicked-interactive](https://github.com/mikeparcewski/wicked-interactive) | stable | Foundation-plane document & render engine (HTML/PDF/PPTX + version lineage) that wicked-crew spawns and proxies — surfaced through studio, not visited directly. |
| [wicked-studio](https://github.com/mikeparcewski/wicked-studio) | active | Browser console for wicked-crew — launch/steer governed runs, answer HITL gates, live event streams. Ships bundled inside wicked-crew. |
| [wicked-crew](https://www.npmjs.com/package/wicked-crew) | active | Governed multi-agent execution — drives coding-agent CLIs through durable workflows with deny-dominates dual gates and evidence-re-derived "done". Includes the Studio console. |

> **Dependency, not a product:** `wicked-vault` (npm) is in the registry only so dependency resolution can install it — it is wicked-garden's required evidence backend, not a standalone pick.

<!-- historical -->
> **Retired products** — do not install:
> - `wicked-testing` (retired 2026-08, v0.11.0 final): QE capabilities moved to wicked-garden's `qe` domain; acceptance gate is now wicked-crew.
> - `wicked-brain` (retired 2026-08): memory + knowledge absorbed into wicked-estate. npm package deprecated.
<!-- /historical -->

---

## Supported CLIs

Claude Code · Cursor · Codex · Kiro · OpenCode · GitHub Copilot · Antigravity · Pi

---

## License

MIT
