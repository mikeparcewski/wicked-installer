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
  reports a manual step and writes nothing; its `status` does not report plugins; it stays
  `node:`-only per INTERFACE.md §15) and registers garden itself. If the run added the marketplace
  and the install then fails, the add is rolled back with `claude plugin marketplace remove`; with
  several config dirs each is registered in order and reported (a later failure leaves earlier dirs
  registered). **Legacy copies are left in place**: a bare `~/.claude/plugins/wicked-garden` (from
  `npx wicked-garden install`) or a skills/hooks copy an earlier `install-claude.js` recorded in its
  marker is detected and reported ("legacy wicked-garden copy detected at … — left in place;
  removal will ship separately") — never removed; removal is tracked in
  [#20](https://github.com/mikeparcewski/wicked-installer/issues/20). The bare copy is now only the
  direct path's fallback when **no** Claude Code CLI exists, and the output says so ("copied to …;
  not registered — Claude Code not detected"); on the interactive Claude path (Claude Code was the
  chosen target) it is a manual step instead and nothing is copied. A present-but-broken Claude Code
  is an error. Per-product results stay independent (a garden failure never uninstalls estate or
  bus; the run exits non-zero if any product failed), and with several config dirs a failure in a
  later dir leaves earlier dirs registered — reported, not undone. `install-claude.js uninstall
  wicked-garden` removes nothing — it names `claude plugin uninstall wicked-garden@wicked-garden`
  for the registration it never owned and leaves any legacy copy and its marker record in place,
  byte-identical (#20). A v1 (array) install marker is upgraded to v2 with every legacy product
  entry carried forward (no file manifest, noted as such) instead of being dropped, and legacy
  detection recognises both marker shapes and runs before the script can upgrade the marker. An
  existing install marker that does not parse fails `install-claude.js` closed — exit 1 before any
  staging, copying, deletion or marker write, also under `--dry-run`, with the file and parse error
  named and its bytes left untouched (it used to be silently replaced by an empty v2 marker);
  `status` reports such a marker on stderr and exits 1 regardless of which products are selected
  (a plain `status` or `--all` used to exit 0 because the unparseable marker contributed no ids).
  One generic mechanism now guards every path `install-claude.js` touches below a config dir
  (`lstatChainNoFollow`: marker discovery/read/write, `skills/`, `agents/`, `commands/`, the hooks
  payload, `settings.json`, the MCP state file, backups): every component from the config dir down
  is lstat'd, a symlink anywhere — a symlinked `wicked-installer/` parent included — is refused
  with a typed error, and only a genuinely absent component reads as absent; a dangling marker
  link no longer makes discovery report "Claude not present".
- `--source-root` expands a leading `~` exactly like `--claude-home`. A local checkout's
  `.claude-plugin/marketplace.json` must declare `name` equal to the marketplace wicked-garden is
  installed from — a manifest naming anything else, no name, or invalid JSON is refused before any
  `marketplace add` (the install and rollback commands are addressed by that name). A selected
  `installed_plugins.json` entry that is not an object is reported as a malformed, unhealthy record
  (`partially registered`) instead of being dropped as "not installed"; path-segment validation also
  rejects DEL and C1 control characters.
- The same no-follow walk now covers the two copy paths: the backup file's exact destination leaf
  (a link or an existing file at the predictable `<name>.<stamp>.bak` is left alone and a fresh
  unique name is used; the copy is exclusive) and every directory and file `copyTree` creates under
  the config dir (a link anywhere is refused; symlinks in a product's source tree are never copied
  into the config dir and are reported instead).
- Fail-closed hardening from review: valid JSON of an unrecognised marker shape (`{"products": {}}`,
  an array, a `markerVersion: 2` without a products map …) is unusable like invalid JSON, never
  something a consumer crashes on; a selection that is plugins-only after dependency expansion
  creates no config dir and initialises/upgrades no marker; the picker resolves the Claude config
  dirs (a set-but-empty `CLAUDE_CONFIG_DIR` is an error) before the first dependency is installed;
  `--dry-run` describes every active config dir even when an earlier one is refused, failing the
  product afterwards exactly like the live run.
- Marker and source hardening: every v2 product record and file record is validated field by
  field at parse time (a malformed record makes the marker unusable — fail closed, byte-identical);
  the product's own source manifests (`hooks/hooks.json`, `skills/*/SKILL.md`, the
  `platform/claude` override, `package.json`) are walked no-follow from the staged source root —
  one behind a symlink is never read and the skill / hook set is skipped with a named action; a
  refused backup fails the config write it protects for every product touching that file (nothing
  is remembered as backed up until the exclusive copy succeeded).
- Printed `claude …` commands (dry-run plan, logs, errors) are shell-quoted per platform — POSIX
  `CLAUDE_CONFIG_DIR='…' claude …`, cmd.exe `set "CLAUDE_CONFIG_DIR=…" && claude …` — so a config
  dir with spaces, `$` or `&` reads back correctly; every path component below the config dir is
  lstat'd, so a symlinked `plugins/`, `cache/`, `<marketplace>/`, `<plugin>/`, `<version>/`,
  `plugin.json` or state file makes the registration `unreadable` (error, exit 1) rather than
  merely partial; the recorded `installPath` must equal the expected cache path byte for byte, only trailing
  separators forgiven — no normalisation before the comparison, so `<expected>/alias/..` or an alias
  that merely resolves to it is `partial`; the recorded version must be a single path segment (a value
  such as `alias/1.0.0` is `partial`, never a path); any selected install record without a real version makes the
  dir `partial` ("install record has no version (<scope> scope)") regardless of other entries — never
  completed with a placeholder (the recorded string is kept raw — a padded `" 1.0.0 "` is not
  `1.0.0`); every selected install record must verify — a healthy user-scope record does not excuse
  a project/managed record whose payload is missing or mismatched — and the repair plan chooses
  `update` only when every record is complete, `install` otherwise. The
  dry-run plan applies the same launch-shape validation as the live spawn (a `.cmd`-shim `claude`
  with `%`/`!` in an argument fails the plan too), and on Windows a config dir or argument holding
  `%`/`!` is rendered structurally (argv + env) rather than as a `set "…" && claude …` line that
  cmd.exe would expand to a different path.
- `CLAUDE_CONFIG_DIR` that is set but names no directory ("", blanks, a bare `:`/`,`) is an error
  (exit 1, nothing written) instead of a silent fall-through to `~/.claude` — in the installer and
  in `install-claude.js`.
- `install <ids>` exits 1 when any product failed to install (it previously exited 0).

### Added

- `status` prints, per active Claude config dir, wicked-garden's registration state — marketplace
  present (and its source), installed version/scope, cached versions, enable switch — with one
  verdict shared by install, status and detection: **registered** (marketplace entry + install
  record + the payload at the expected `plugins/cache/<marketplace>/<plugin>/<version>` path with a
  matching `plugin.json` version), **partially registered (…)** naming what is missing, **copy
  only (unregistered)** for a bare `plugins/wicked-garden` copy, **not installed**, or
  **unreadable (…)** when a state file (or any path component) is a symlink, resolves outside the
  config dir, or cannot be read. The **overall** line is the worst state across the active dirs and
  `status` exits 1 unless wicked-garden is registered in every one of them; the product list's
  "installed" means the same. Read from disk without following symlinks; `status` runs no `claude
  plugin` command (its CLI detection runs the read-only `claude --version` probe, which writes
  nothing).
- `--claude-home <dir>` (repeatable) on the direct `install` and `status` paths, and
  `--source-root <dir>` on the direct `install` path (registers the local checkout
  `<dir>/wicked-garden` as the marketplace instead of GitHub; `status` is read-only and takes no
  source). Both are also passed through to the per-CLI install scripts on the interactive path
  (`--claude-home` to the Claude script only).
- Registry: optional `install.marketplace` / `install.pluginId` fields for `claude-plugin`
  products (defaults `mikeparcewski/<id>` / `<id>@<id>`).
- `wicked-garden` detection (`status` product list) now means *registered with Claude Code* in every
  active config dir (honouring `--claude-home`) — a bare copy under `~/.claude` or a stale install
  record no longer counts, so the product list agrees with the registration detail.
- `--source-root` without Claude Code fails instead of silently installing the published package
  through the `npx` fallback, and a root without `.claude-plugin/marketplace.json` fails fast —
  before the first dependency is installed, on every path (direct, interactive, zero-CLI) and
  also under `--dry-run` — so an invalid invocation never leaves a partial install behind. On Windows, a `.cmd`-shim `claude` is refused `%`/`!`-bearing arguments (cmd.exe
  would expand them; INTERFACE.md §1.1) rather than passing a rewritten path to Claude Code.
