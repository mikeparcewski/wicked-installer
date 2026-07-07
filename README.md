```
 __      _      _            _
/ _|    (_)    | |          | |
| |_ _   _ ___| | _____  __| |
|  _| | | / __| |/ / _ \/ _` |
| | | |_| \__ \   <  __/ (_| |
|_|  \__,_|___/_|\_\___|\__,_|

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
wicked-installer                 Interactive install
wicked-installer list            List available products
wicked-installer install <ids>   Install specific products (space-separated)
wicked-installer status          Show detected CLIs + installed products
wicked-installer --version
```

---

## Bundles

| Bundle | What it installs | Best for |
|---|---|---|
| `quick-start` | wicked-testing | Fastest path to acceptance testing — standalone, no deps |
| `garden` | wicked-bus + wicked-garden + wicked-testing | Recommended starting point — evidence-gated work + full QE pipeline |
| `knowledge` | wicked-bus + wicked-estate + wicked-brain | Persistent memory and code-graph layer |
| `full` | Everything stable | The complete wicked-\* experience |

---

## Products

| Product | What it does |
|---|---|
| [wicked-testing](https://github.com/mikeparcewski/wicked-testing) | 47-skill QE pipeline with 3-agent acceptance testing. Eliminates self-grading. |
| [wicked-bus](https://www.npmjs.com/package/wicked-bus) | Local-first SQLite event bus. At-least-once delivery, no network transport. |
| [wicked-brain](https://www.npmjs.com/package/wicked-brain) | Digital brain + Claude Code skills adapter. Indexes codebase knowledge. |
| wicked-estate | MCP server: code graph + memory + knowledge in one binary. 23 tools. |
| wicked-garden | Curated toolkit for what coding agents can't do alone. |
| wicked-signals | Text-in / intent-out classifier. Routes Slack threads, alerts, file changes. |

---

## Supported CLIs

Claude Code · Cursor · Codex · Kiro · OpenCode · GitHub Copilot · Antigravity · Pi

---

## License

MIT
