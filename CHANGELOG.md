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
  present (#18): the active config dir(s) are resolved exactly as `install-claude.ts` does
  (`--claude-home` → `CLAUDE_CONFIG_DIR` → `~/.claude`), and for each one the installer runs
  Claude Code's own mechanism with `CLAUDE_CONFIG_DIR=<target>` — `claude plugin marketplace add
  mikeparcewski/wicked-garden` (skipped when the marketplace is already registered) then `claude
  plugin install wicked-garden@wicked-garden` (or `claude plugin update` when already installed) —
  and verifies the payload landed in `<target>/plugins/cache/wicked-garden/wicked-garden/<version>`,
  the location Claude Code loads and wicked-crew reads. The former `npx wicked-garden install`
  bare copy (always into `~/.claude/plugins/wicked-garden`, loaded by nothing) is now only the
  fallback when Claude Code is absent, and the output says so ("copied to …; not registered —
  Claude Code not detected").
- `install <ids>` exits 1 when any product failed to install (it previously exited 0).

### Added

- `status` prints, per active Claude config dir, wicked-garden's registration state — marketplace
  present (and its source), installed version/scope, cached versions — and marks a bare
  `plugins/wicked-garden` copy as **copy only (unregistered)**. Read from disk only; the `claude`
  CLI is never invoked by `status`.
- `--claude-home <dir>` (repeatable) and `--source-root <dir>` on the direct `install` and
  `status` paths (`--source-root <dir>` registers the local checkout `<dir>/wicked-garden` as the
  marketplace instead of GitHub). Both are also passed through to the per-CLI install scripts on
  the interactive path (`--claude-home` to the Claude script only).
- Registry: optional `install.marketplace` / `install.pluginId` fields for `claude-plugin`
  products (defaults `mikeparcewski/<id>` / `<id>@<id>`).
- `wicked-garden` detection (`status` product list) now counts a registration in any active config
  dir, not only a bare copy under `~/.claude`.
