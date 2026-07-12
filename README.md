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
npx wicked-installer status          Show detected CLIs + installed products
npx wicked-installer --version
```

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
