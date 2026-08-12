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
npx wicked-installer status          Show detected CLIs + installed products
npx wicked-installer --version
```

---

## Skill packs (the wicked-garden extension contract)

Third parties extend the wicked-garden catalog with **packs** — a
`wicked-pack.json` manifest plus a `skills/` tree following the
`{vendor}-{domain}` router / `{vendor}-{domain}-{role}` worker contract.
This command is the single acquisition path (garden's own
`npx wicked-garden pack install` delegates here):

```
npx wicked-installer pack add acme-seo-pack        # npm package
npx wicked-installer pack add ./acme-seo-pack      # local directory
npx wicked-installer pack remove acme-seo
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
| `quick-start` | wicked-testing | Fastest path to acceptance testing — standalone, no deps |
| `garden` | wicked-bus + wicked-garden + wicked-testing | Recommended starting point — evidence-gated work + full QE pipeline |
| `knowledge` | wicked-bus + wicked-estate + wicked-brain | Persistent memory and code-graph layer |
| `creative` | wicked-interactive + wicked-crew | Self-contained HTML artifact builder + the AI workflow console (Studio ships inside Crew) |
| `full` | Everything stable | The complete wicked-\* experience |

---

## Products

| Product | What it does |
|---|---|
| [wicked-testing](https://github.com/mikeparcewski/wicked-testing) | 48-skill QE pipeline (40 specialist + 8 Tier-1 workflow skills) with acceptance testing that eliminates self-grading. |
| [wicked-bus](https://www.npmjs.com/package/wicked-bus) | Durable event fabric for agents — restart-durable at-least-once delivery with dead-lettering and replay. Zero infra (embedded SQLite), single-host. |
| [wicked-brain](https://www.npmjs.com/package/wicked-brain) | Digital brain + Claude Code skills adapter. Indexes codebase knowledge. |
| wicked-estate | MCP server: code graph + memory + knowledge in one binary. 23 tools. |
| wicked-garden | Curated toolkit for what coding agents can't do alone. Claude Code plugin. |
| wicked-interactive | Design and vibe canvas — build self-contained interactive HTML artifacts. |
| [wicked-crew](https://www.npmjs.com/package/wicked-crew) | Agentic execution platform — drives coding-agent CLIs through governed workflows. Includes the Studio operator console (browser HITL: live topology, gates, evidence). |

---

## Supported CLIs

Claude Code · Cursor · Codex · Kiro · OpenCode · GitHub Copilot · Antigravity · Pi

---

## License

MIT
