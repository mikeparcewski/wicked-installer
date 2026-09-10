# Changelog

All notable changes to wicked-installer are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Fixed

- `--dry-run` is now dry for **every** product type on the direct `install <ids>` path and the
  interactive zero-CLI path: it prints the exact plan (target dirs, commands) and runs nothing
  that writes — no `npm`/`npx`/`cargo`/`git` spawns, no GitHub downloads, no file copies
  (#18). Before this, `install wicked-garden --dry-run` ran `npm install -g wicked-vault` and
  garden's real `install.mjs`.
- `wicked-garden` is installed as a **registered Claude Code plugin** when the `claude` CLI is
  present (#18), on every path — `install <ids>`, the interactive Claude script
  (`install-claude.js`) and the interactive zero-CLI path. The active config dir(s) are resolved
  the same way everywhere (`--claude-home` → `CLAUDE_CONFIG_DIR` → `~/.claude`), and for each one
  the installer probes (`claude --version` + the on-disk registration state) and then runs only
  what that state calls for, with `CLAUDE_CONFIG_DIR=<target>` — `claude plugin marketplace add
  mikeparcewski/wicked-garden` when the marketplace is absent, then `claude plugin install
  wicked-garden@wicked-garden` (or `claude plugin update` for a healthy existing install) — and
  re-derives from disk that marketplace entry, install record and matching payload under
  `<target>/plugins/cache/wicked-garden/wicked-garden/<version>` all exist, the location Claude
  Code loads and wicked-crew reads. On the interactive path the picker hands `install-claude.js`
  the products *without* garden (the script never installs a plugin — handed one directly it
  reports a manual step and writes nothing; it stays `node:`-only per INTERFACE.md §15), registers
  garden itself, and only after that succeeds removes a legacy skills/hooks copy an earlier script
  install recorded, through the script's own marker-driven `uninstall`. The former `npx
  wicked-garden install` bare copy (always into `~/.claude/plugins/wicked-garden`, loaded by
  nothing) is now only the direct path's fallback when **no** Claude Code CLI exists, and the output
  says so ("copied to …; not registered — Claude Code not detected"); on the interactive Claude
  path (Claude Code was the chosen target) it is a manual step instead and nothing is copied. A
  present-but-broken Claude Code is an error, and on any failure nothing else is touched.
  `install-claude.js uninstall wicked-garden` names `claude plugin uninstall wicked-garden@wicked-garden`
  for the registration it never owned.
- `install-claude.js uninstall` refuses marker-recorded paths that are absolute, home-relative,
  parent-traversing, outside the roots the script writes (`skills/`, `agents/`, `commands/`,
  `wicked-installer/products/<id>/`) or that realpath-resolve outside the config dir, and config
  entries in any file other than the MCP state file or `settings.json` — each reported as a
  `skipped` action with a `refused: …` diagnostic. Those two config files are also accepted
  only when they really are files: a symlinked `settings.json` or MCP state file is refused (no
  read, no backup, no replace) on uninstall and on install (`mcp`/hooks wiring) alike. The
  selectors inside an entry are data too: a `hooks-entry` is honoured only with this product's own
  owner key (`wicked-installer/products/<id>`) on a well-formed event, and a `json-key` only with an
  `/mcpServers/<name>` pointer — so a hand-edited marker cannot delete a user's own hooks or keys.
- Printed `claude …` commands (dry-run plan, logs, errors) are shell-quoted per platform, so a
  config dir with spaces, `$` or `&` reads back correctly; payload symlink/containment/permission
  failures make the registration `unreadable` (error, exit 1) rather than merely partial; an
  install record without a version is `partial` ("install record has no version") — never
  completed with a placeholder.
- `CLAUDE_CONFIG_DIR` that is set but names no directory ("", blanks, a bare `:`/`,`) is an error
  (exit 1, nothing written) instead of a silent fall-through to `~/.claude` — in the installer and
  in `install-claude.js`.
- `install <ids>` exits 1 when any product failed to install (it previously exited 0).

### Added

- `status` prints, per active Claude config dir, wicked-garden's registration state — marketplace
  present (and its source), installed version/scope, cached versions, enable switch — with one
  verdict shared by install, status and detection: **registered** (marketplace entry + install
  record + the payload at the expected `plugins/cache/<marketplace>/<plugin>/<version>` path with a
  matching `plugin.json` version), **partially registered (…)** naming
  what is missing, **copy only (unregistered)** for a bare `plugins/wicked-garden` copy, or
  **unreadable (…)** — exit 1 — when a state file is a symlink, resolves outside the config dir,
  or cannot be read. Read from disk without following symlinks; `status` runs no `claude plugin`
  command (its CLI detection runs the read-only `claude --version` probe, which writes nothing).
- `--claude-home <dir>` (repeatable) and `--source-root <dir>` on the direct `install` and
  `status` paths (`--source-root <dir>` registers the local checkout `<dir>/wicked-garden` as the
  marketplace instead of GitHub). Both are also passed through to the per-CLI install scripts on
  the interactive path (`--claude-home` to the Claude script only).
- Registry: optional `install.marketplace` / `install.pluginId` fields for `claude-plugin`
  products (defaults `mikeparcewski/<id>` / `<id>@<id>`).
- `wicked-garden` detection (`status` product list) now means *registered with Claude Code* in one of
  the active config dirs (honouring `--claude-home`) — a bare copy under `~/.claude` or a stale
  install record no longer counts, so the product list agrees with the registration detail.
- `--source-root` without Claude Code fails instead of silently installing the published package
  through the `npx` fallback, and a root without `.claude-plugin/marketplace.json` fails fast —
  before the first dependency is installed, on every path (direct, interactive, zero-CLI) and
  also under `--dry-run` — so an invalid invocation never leaves a partial install behind. On Windows, a `.cmd`-shim `claude` is refused `%`/`!`-bearing arguments (cmd.exe
  would expand them; INTERFACE.md §1.1) rather than passing a rewritten path to Claude Code.
