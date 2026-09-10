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

So when the `claude` CLI is present, every garden install path — `install wicked-garden`,
the interactive path with Claude Code selected (the picker hands `install-claude.js` the
other products, then registers garden itself and only afterwards removes a legacy
skills/hooks copy through the script's own `uninstall`), and the interactive zero-CLI
path — resolves the active config dir(s) the same way: `--claude-home` flags,
else `CLAUDE_CONFIG_DIR` (a list split on `:` or `,`; on Windows on `;` or `,`;
authoritative when **set** — a set-but-empty value is an error, not a fall-through),
else `~/.claude`. For **each** dir it probes (`claude --version`, plus the on-disk
registration state) and then runs only what that state calls for, with
`CLAUDE_CONFIG_DIR=<target>`:

```
claude plugin marketplace add mikeparcewski/wicked-garden   # only when the marketplace is absent
claude plugin install wicked-garden@wicked-garden           # or `update` when a healthy install exists
```

then re-derives from disk that the marketplace entry, the install record and the
payload under `<target>/plugins/cache/wicked-garden/wicked-garden/<version>/` (with a
matching `plugin.json` version) all exist. A marketplace already registered from another
source (say, a local checkout) is kept as-is. `--source-root <dir>` registers
`<dir>/wicked-garden` as the marketplace instead of GitHub. `--dry-run` prints the same
probes (`probe:` lines) and exactly the commands a live run would execute (`dry-run:`
lines); the only thing it spawns is `claude --version`.

State is read from `plugins/known_marketplaces.json` / `plugins/installed_plugins.json`
(what `claude plugin marketplace list --json` / `claude plugin list --json` print) rather
than by running those commands, because they initialise `<configDir>/.claude.json` as a
side effect. Nothing is written into `skills/`, `settings.json` or `.claude.json` for
garden — those writes remain only for products that need them (wicked-estate's MCP block).

When **no** Claude Code CLI is present the direct path (`install wicked-garden`) falls
back to `npx wicked-garden install` and says so: *copied to ~/.claude/plugins/wicked-garden;
not registered — Claude Code not detected*. On the interactive path, where you chose Claude
Code as the target, garden is instead reported as a **manual step** and nothing is copied —
a copy Claude Code never loads is not an install of what you selected. A Claude Code that is
present but fails `claude --version` is
an **error**, never a fallback — and on any failure nothing else is touched (a legacy copy
is removed only after registration succeeded). `--source-root` never falls back either:
the bare copy would install the published package, not your checkout. `install-claude.js`
itself never installs a plugin (handed one directly, it reports a manual step and writes
nothing) and imports nothing outside `node:` builtins.

`status` prints, per active config dir, the marketplace (and its source), the
installed version/scope, the cached versions, the enable switch, and a verdict:
**registered** only when the marketplace entry, the install record and a payload whose
`plugin.json` version matches the record all exist; **partially registered (…)** naming
what is missing when a record survives without its marketplace or payload; **copy only
(unregistered)** for a bare `plugins/wicked-garden` copy; **unreadable (…)** — an error,
exit 1 — when a state file is a symlink, resolves outside the config dir, or cannot be
read. The product list's "installed" for wicked-garden means *registered* — a bare,
partial or unreadable install is not something Claude Code can load. `status` runs no
`claude plugin …` command; its CLI detection runs the read-only `claude --version`
probe (verified to write nothing) and nothing else.

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
