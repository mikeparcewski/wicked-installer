# wicked-installer — Per-CLI Install Script Interface

**Contract v1 (frozen) + v1.1 extensions (opt-in)**

**Status:** v1 is the shipped, de-facto convention. **`src/install-codex.ts` is the SINGLE normative reference implementation** — the one file you read to see the v1 install flow, flag surface, staging, skills handling, marker, and report envelope in working code. v1.1 is a set of additive, opt-in extensions specified normatively **by this document plus the JSON schemas in `schemas/`** (not by any script): MCP wiring, verbs (`status`/`uninstall`), install-marker v2, hooks wiring, convergence, and central-picker integration. codex is a v1 script (it does not implement v1.1); the v1.1 behavior is fully specified in prose + schema here, so you never need to read a v1.1 implementation to build one.

**Every other `install-<cli>.ts` is OWNED and MAINTAINED by its CLI team and MAY diverge from this contract — none of them is normative.** In particular, `src/install-antigravity.ts` (the Gemini family) makes its own choices — its home (`~/.gemini`), its overrides, its spawn handling. Those choices belong to the antigravity team and are **explicitly NOT specified or required by this contract**; do not treat that file's internals as a spec, and do not open it to build your own script. `src/install-claude.ts` is the first v1.1 implementation and is likewise team-owned; the normative v1.1 behavior lives in this document and the schemas, not in that file.

**Audience:** the team that owns a coding CLI and wants wicked-* products installed into it. You write ONE file. The central installer discovers and drives it. You never touch another CLI's script. **This document + `schemas/` + `src/install-codex.ts` must be sufficient to implement without reading any other `install-<cli>.ts` and without asking questions** — if you find yourself needing to open another CLI's script or to ask, that is a spec bug; file it.

---

## 1. Model

There is no adapter protocol, no adapter.json, no per-product manifest files, no subprocess verb JSON-RPC. The convention is:

- **One standalone executable per CLI**: `src/install-<cli>.ts`, compiled to `dist/install-<cli>.js` and chmod'd by the build script (`package.json` `scripts.build` — add your file to the chmod list). It is **self-contained by design**: it duplicates the registry types inline rather than importing from `src/types.ts`, so each CLI team owns exactly one file with zero shared-module coupling.
- **`registry.json` is the single product truth.** Scripts consume it directly: product ids, `requires` dependency resolution, `status` filtering, `install` acquisition spec, and (v1.1) the optional `mcp` block.
- **Acquisition is duplicated, not centralized.** Each script performs binary/package acquisition (`npm -g`, `cargo install`, GitHub release download) itself. Running two CLI scripts acquires twice; this is ACCEPTED because acquisition is idempotent (second run is a fast no-op). The central picker passes `--skip-binaries` to the 2nd..nth script it spawns.
- **Integration is per-CLI.** Each script copies staged assets into its own CLI's config layout and (v1.1) wires MCP/hooks into its own CLI's config files.
- **Re-run = converge.** Idempotent installs, no duplicates, second run with unchanged inputs is a fast no-op reported as success.

### 1.1 Runtime requirements

- Node ≥ 20, ESM (`"type": "module"`), **`node:` builtins only — no external dependencies** in install scripts (the interactive deps in package.json belong to `src/index.ts` only).
- **Cross-platform is mandatory** (macOS, Linux, Windows): `path.join`/`resolve` everywhere; `where` vs `which` gated on `process.platform === "win32"`; no unix-only shell tricks; never hand-assemble JSON strings (`JSON.stringify` handles backslash escaping on Windows paths).
- **Windows spawn rule (REQUIRED for new scripts; known v1 nonconformance in codex/antigravity — see Appendix A, J-9).** On native Windows, `spawnSync("npm", …)` / `spawnSync("npx", …)` without a shell throws `EINVAL`: npm/npx are `.cmd` shims and Node ≥ 20.12 (CVE-2024-27980) refuses to auto-resolve a `.cmd`/`.bat` unless `shell: true`. `git.exe`, `cargo.exe`, `node.exe`, `tar`, `unzip`, `where`/`which` are **real executables** — spawn them WITHOUT a shell and with **unquoted** args. The rule below applies **only** when the launched command is `npm`, `npx`, or any other `.cmd`/`.bat`. "Resolve the `.cmd` via `where` and spawn it directly" does **not** work — a resolved `foo.cmd` path still needs `shell: true` under Node ≥ 20.12 — so it is not an alternative; use the recipe.

  **Canonical recipe — the two code blocks below are the complete, self-contained reference; copy them verbatim and do not invent your own.** You do not need to open any script to reproduce this — everything required is inline here. (The codex reference `run()` omits it — that is the documented J-9 caveat, and it is why you must copy the snippet below rather than model `run()` on codex as-shipped.) When `process.platform === "win32"` and `cmd` is `npm`/`npx`, spawn with `{ shell: true }` and pass **every** argument through the exact `winQuote` helper below. Under `shell: true` Node itself builds `cmd.exe /d /s /c "<cmd> <args…>"` and sets `windowsVerbatimArguments`, so your pre-quoted tokens reach cmd verbatim (Node adds no quoting of its own). Never pipe a real executable's args through the shell or through `winQuote`.

  ```ts
  // Quote ONE argument for cmd.exe when spawning an npm/npx .cmd shim with { shell: true }.
  // Implements the CommandLineToArgvW backslash/quote rule (MSVCRT); the surrounding double
  // quotes then neutralize every cmd metacharacter that is literal inside quotes:
  // space  &  |  <  >  (  )  ^  and  "  itself. (See the %/! caveat below.)
  function winQuote(arg: string): string {
    if (arg === "") return '""';
    // Bare pass-through only for a conservatively safe, metacharacter-free set (no %).
    if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
    let out = '"';
    for (let i = 0; i < arg.length; ) {
      let slashes = 0;
      while (i < arg.length && arg[i] === "\\") { slashes += 1; i += 1; }
      if (i === arg.length) { out += "\\".repeat(slashes * 2); break; }        // before closing quote
      else if (arg[i] === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; i += 1; } // doubled + escaped
      else { out += "\\".repeat(slashes) + arg[i]; i += 1; }
    }
    return `${out}"`;
  }
  ```

  Wire it exactly like this — gate the shell and the quoting together, and only for npm/npx:

  ```ts
  const useShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const result = spawnSync(cmd, useShell ? args.map(winQuote) : args, {
    cwd, encoding: "utf8", shell: useShell,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  ```

  **The one caveat you must respect — `%` and `!`.** cmd.exe expands `%VAR%` (always) and `!VAR!` (only when delayed expansion is enabled) **even inside double quotes**, and there is no command-line escape for either — so `winQuote` cannot neutralize a literal `%` or `!`, and `%` is deliberately kept OUT of the bare-pass-through set. This is safe for the installer because (a) Node spawns cmd without `/v:on`, so `!` is inert, and (b) the only values ever routed through npm/npx are package names, semver strings, and an OS temp path (`mkdtemp` under `tmpdir()`), none of which legitimately contain `%` or `!`. A new script MUST NOT pass `%`/`!`-bearing user data (e.g. a crafted `--source-root`) to a `.cmd` shim — route such values only through the real executables (git/cargo/node), which take unquoted args and never invoke cmd.
- **Tilde expansion** everywhere a path value is accepted: leading `~` only, followed by `/`, `\`, or end-of-string, replaced using a **function replacement** — `value.replace(/^~(?=$|[/\\])/, () => homedir())` — never a string replacement, so `$&` in a home path cannot corrupt it.

---

## 2. File layout & naming

| Artifact | Path | Rule |
|---|---|---|
| Source | `src/install-<cli>.ts` | `<cli>` is a lowercase slug (`codex`, `antigravity`, `claude`) — one script per config root (§2.1). A config-root *family name* need not equal a slug — e.g. `gemini` names a shared home that a team-owned script targets, not a second install-script slug (§2.1) |
| Built executable | `dist/install-<cli>.js` | `#!/usr/bin/env node` shebang; chmod 0o755 by the build script |
| Build registration | `package.json` `scripts.build` | Add `dist/install-<cli>.js` to the chmod list in the `node -e` step |
| Install marker | `<configDir>/wicked-installer/<cli>-install.json` | One per config dir the script writes into (§10) |
| Product payload root | `<configDir>/wicked-installer/products/<productId>/` | v1.1, hooks/runtime files (§8.4) |
| Backups | `<configDir>/wicked-installer/backups/` | v1.1 (§8.3), newest 5 kept |
| Home env var | `<CLI>_HOME` (e.g. `CODEX_HOME`) | Consulted before the built-in default |
| Home flag | `--<cli>-home <dir>` | §3 |

**The one rule when your config-root name differs from your slug: home naming follows the config-root owner; marker naming follows your script.** As a *non-normative* illustration only: the antigravity team's script (which that team owns and specifies) targets the Gemini family's shared home instead of a `~/.antigravity` home, so it uses `--gemini-home` (with `--antigravity-home` as an alias), env var `GEMINI_HOME`, report key `geminiHome`, and marker `<geminiHome>/wicked-installer/antigravity-install.json`. Those particular names are that team's choices, not something this contract mandates or that you need to reproduce — the only thing you must follow is the bold rule.

### 2.1 Config-root ownership is exclusive — one owning script per home

**Invariant: exactly one install script writes into any given config root.** Two scripts sharing a home is forbidden. Every downstream rule assumes a single owner: the marker (§10), skills convergence (§8.5), and skill-collision (§8.6) semantics. Two co-owning scripts would clobber each other's skills (their §7.1 destination names are byte-identical — both apply the same `<productId>-` sanitizer), delete each other's payload dirs and marker-listed `files[]` on `uninstall` (§12.3), and drop two markers into one `wicked-installer/` describing the same on-disk files. This is why the seed contract's "per-CLI skill namespacing vs shared" and "refuse-foreign-marker vs clobber" questions never arise: there is never a second script in the dir to reconcile with.

**Illustration — the Gemini family is one config root, not two (non-normative).** Google Antigravity and the Gemini CLI both read `~/.gemini`, so it is a single config root with a single owner. That owner is the antigravity team's script (which they own and specify); **how it populates `~/.gemini` is that team's concern and is NOT specified by this contract** — you never need to read it or reproduce it. What the contract fixes is only the invariant above: `~/.gemini` has exactly one owning script, so there is **no** `install-gemini.ts` — `gemini` is a config-root family name and a detection alias (§11.2), never a second install-script slug. Shipping a second script that co-writes `~/.gemini` violates the invariant and is rejected by the picker (§14).

**A CLI that needs isolated integration MUST use a distinct config root.** Never co-write a home another script owns. Before copying `install-codex.ts`, a new-CLI author confirms their `--<cli>-home` default does not resolve to a home an existing script already owns (§15, step 4). If a real, separate Gemini-family integration is ever required with different assets, it takes its own root (e.g. `~/.gemini-wicked`) — it does not fork ownership of `~/.gemini`.

---

## 3. Command-line interface

### 3.1 Invocation grammar

```
install-<cli> [verb] [product ids...] [flags]
verb := install | status | uninstall        (v1.1; default: install)
```

**Verb detection rule:** if the FIRST positional argument is exactly `install`, `status`, or `uninstall`, it is the verb; otherwise the verb is `install` and all positionals are product ids. This preserves every existing codex invocation byte-for-byte (`install-codex wicked-testing --json` still works). No ambiguity exists because all registry product ids start with `wicked-`; registry product ids MUST never equal a verb name.

v1 scripts implement only the implicit `install` verb. That is conforming.

### 3.2 Flags (shared, argv-compatible with install-codex)

Every value flag MUST accept both `--flag value` and `--flag=value` (slice from the FIRST `=` so values containing `=` survive). Values are tilde-expanded (§1.1) then made absolute with `resolve()`.

| Flag | Semantics |
|---|---|
| *(positional)* | Product ids, accumulated in order. Anything not starting with `-` is a product id (after verb extraction). |
| `--products a,b` | Comma-split, trimmed, empties dropped, appended to positional ids. Repeatable. |
| `--all` | Select every registry product whose `status !== "design"`. For `uninstall`: every product in the marker. |
| `--<cli>-home <dir>` | Target config root. Default: `$<CLI>_HOME` (tilde-expanded) if set, else `~/.<cli>`. Multi-config-dir CLIs (claude): repeatable, each occurrence adds a target (§11). |
| `--registry <file>` | Registry path. Default: `<script-dir>/../registry.json` if it exists (packaged copy next to `dist/`), else `<cwd>/registry.json`. |
| `--source-root <dir>` | Root of local wicked-* checkouts, tried before npm pack. Default: `$WICKED_SOURCE_ROOT`, else auto-probe `<script-dir>/../..`, `<cwd>/..`, `<cwd>` — first candidate containing `wicked-installer/registry.json` or `wicked-testing/package.json`; final fallback `<cwd>`. |
| `--skip-binaries` | Skip the acquisition step entirely (§5); asset copying still happens. A note is recorded per product. |
| `--dry-run` | Print every command/copy/write that would happen; write nothing outside the OS temp dir. §13. |
| `--json` | Emit the machine-readable report (§9) instead of human lines. Suppresses the script's own human logging. |
| `--force` | v1: parsed and accepted but a no-op (copies already overwrite). v1.1: bypasses the "already current" marker short-circuit, takes ownership in skill collisions (§8.6), overwrites foreign MCP keys recording `prior` (§8.3). Always accept it; never repurpose it. |
| `--purge-binaries` | v1.1, `uninstall` only: opt in to `npm rm -g` / `cargo uninstall` (§12.3). |
| `--help`, `-h` | Print usage, exit 0. Routed before verb defaulting. |

Unknown `-`-prefixed arguments MUST throw (`unknown option: <arg>`) → exit 1. A value flag given as the last token with no value falls through to the unknown-option error — bare `--<cli>-home` is rejected, never silently defaulted. No products selected and no `--all` → error `no products selected; pass product ids or --all`, exit 1.

### 3.3 Exit codes

| Code | Meaning |
|---|---|
| `0` | Every report entry has `success: true` — including `skipped` manual products and "already current" no-ops. Converging is success. |
| `1` | Any per-product failure, or a top-level error (bad flags, unreadable registry, unknown product id). Partial success is a non-green run. |
| `2` | **v1.1, `status`/`uninstall` only:** CLI not present — neither the CLI home nor a marker exists. `install` NEVER exits 2: selecting a CLI is consent to create its home (normative behavior, shown by the codex reference `main()`, which logs and creates the home when the CLI is absent). |

v1 scripts use only 0/1. The central picker treats a script's exit 2 as "CLI not present", not an error.

---

## 4. Registry consumption

Load `registry.json`, require `products` to be an array (else `invalid registry: <path>`, exit 1). Relevant fields per product:

```jsonc
{
  "id": "wicked-testing",
  "displayName": "Wicked Testing",
  "status": "stable" | "active" | "preview" | "design",
  "requires": ["wicked-bus"],          // hard deps, auto-installed
  "recommended": ["wicked-brain"],     // informational ONLY — never auto-installed
  "install": { "type": "...", ... },   // acquisition spec, §5
  "mcp": { ... }                        // v1.1, optional, §8.3 — ignore if unsupported
}
```

**Selection & dependency resolution** (exactly the codex reference's `resolveProducts`):
1. Requested set = explicit ids, or (with `--all`) every product with `status !== "design"`. Explicitly naming a design-status product IS allowed — no status filter on explicit ids (deliberate escape hatch; such products carry `manual` install type, which just prints instructions).
2. Unknown id → error `unknown product: <id>`, exit 1.
3. Expand `requires` recursively, depth-first, deduplicating with a seen-set (mark seen BEFORE recursing — cycle-safe). Prerequisites are ordered BEFORE dependents.

**Unknown-field tolerance is mandatory.** Your script MUST ignore registry fields it doesn't understand — this is how the v1.1 `mcp` block ships without touching codex/antigravity.

**Product composition facts (current truth — do not resurrect):** `wicked-vault` is absorbed into `wicked-testing` (ships `bin/wicked-vault.mjs` + `skills/wicked-vault` inside the testing package; no standalone entry, ever). `wicked-loom` is absorbed into `wicked-garden` (no loom entries). `wicked-studio` ships inside `wicked-crew` (registry says `manual`/bundled — keep). `wicked-signals` is **archived** — removed from the ecosystem; no entry. There are no standalone `wicked-vault` / `wicked-loom` / `wicked-signals` / `wicked-studio` product entries. The complete asset taxonomy is **skills + mcp + hooks + bins**; `agents/` and `commands/` are legacy dirs, already skills-only upstream and **copied by no conforming script** (§7.2).

### 4.1 The registry `mcp` block (v1.1)

Product entries MAY carry an optional block; each key is a server name, each value the standard MCP stdio launch spec:

```json
"mcp": {
  "wicked-estate": {
    "command": "wicked-estate-mcp",
    "args": [],
    "env": {
      "WICKED_ESTATE_DB":    "~/.wicked-estate/graph.db",
      "WICKED_MEMORY_DB":    "~/.wicked/memory.db",
      "WICKED_KNOWLEDGE_DB": "~/.wicked/knowledge.db",
      "WICKED_XEDGE_DB":     "~/.wicked/xedge.db"
    }
  }
}
```

This exact entry ships on `wicked-estate` (currently the only product with an `mcp` block). All four DBs are pinned explicitly so the store-path collision panic in `wicked-estate-mcp` can never trigger, and the graph DB stops being cwd-relative — MCP hosts launch servers with unpredictable cwd. `WICKED_ESTATE_DB` is the home-anchored form of the binary's own default (`.wicked-estate/graph.db`, cwd-relative) — see Appendix A, J-7.

Expansion semantics at wire time: leading `~/` or `~\` in `command` and every `env` value expands per §1.1. No other token expansion; `${...}` passes through untouched. `command` stays a bare name (PATH-resolved by the CLI host); the script verifies it resolves and, when it doesn't, warns with the `~/.cargo/bin` / `%USERPROFILE%\.cargo\bin` PATH hint.

Scripts that don't implement registry-`mcp`-**block** wiring MUST silently ignore the block and keep surfacing `install.mcpInstructions` prose. **This is exactly what both bundled scripts do toward the block today.** The codex reference reads no `mcp` block and performs **no** registry-block JSON wiring: its install flow does not register any MCP server — for a product carrying `install.mcpInstructions` it appends that prose to the product's notes and does nothing else MCP-related at runtime. (The codex *source* carries three unwired, never-called mechanism-2 helpers — `registerCodexMcp`/`codexMcpServerExists`/`cargoBinaryPath` — that are dead code, not part of the install flow, and must not be modeled on; see §8.3.) Antigravity behaves the same (registers no MCP server, touches no MCP config, surfaces the prose). §8.3 defines the two possible MCP mechanisms and which one a new CLI should use; whether a given CLI *also* performs CLI-native registration through its own `mcp add`-style subcommand is that CLI team's own integration detail — not part of this contract, and never something you model your script on.

---

## 5. Acquisition

Runs first, per product, unless `--skip-binaries` (which replaces the whole step with the note `binary/package installation skipped by --skip-binaries`). Dispatch on `install.type`:

| type | Behavior |
|---|---|
| `npm-global` | `npm install -g <install.package>`. Missing `package` → error. |
| `cargo` | `cargo install <install.crate ?? install.package>`, plus `--version <install.version>` when pinned. `cargo` not on PATH → error `cargo not found; install Rust from https://rustup.rs and retry`. |
| `github-binary` | Fetch `https://api.github.com/repos/<githubRepo>/releases/latest` (via `node -e` + `fetch` — no curl/wget dependency); pick the first asset matching `install.assetPattern` (regex) or default `new RegExp(\`${os}.*${cpu}|${cpu}.*${os}\`, "i")` with `os ∈ {darwin,linux,windows}`, `cpu ∈ {x86_64,aarch64}`, skipping `.sha256`. Download to a temp dir; extract (`unzip -o` for `.zip` on non-Windows, `tar -xf` otherwise — Win10+ bsdtar handles zips); locate via `findBinary` (prefer `<productId>`, `<productId>-mcp`, `<productId>*`; skip doc/text extensions). Install dir: `~/.local/bin/<productId>` + `chmod 0o755` on unix; **`%LOCALAPPDATA%\wicked\bin\<productId>.exe`, no chmod, PATH-hint note on Windows** (gate on `process.platform`). No current registry product uses this type; the Windows mapping is specified now so the first one that does cannot ship a unix-ism (Appendix A, J-14). |
| `npm-run` | **Do NOT run the package's own installer** (`npx <pkg> install` may target other CLIs). Record a note explaining this; assets are still staged and copied by THIS script (§6–7). Transitional type. |
| `manual`, `binary` | No action. Note = `install.instructions` (or a generic "requires manual installation"). Report gets `skipped: true`. |
| `git-plugin` | No acquisition action (assets come from the git staging path, §6). Note recorded. |
| *(anything else)* | Hard error — TypeScript exhaustiveness check (`const never: never = install.type`). |

If `install.mcpInstructions` is present, append it verbatim to the product's notes (v1.1 MCP wiring supersedes it functionally for scripts that implement §8.3, but keep emitting the note).

Child processes: `spawnSync` (with the Windows `.cmd` rule of §1.1), `stdio: "inherit"` for interactive output or `["ignore","pipe","pipe"]` when capturing; non-zero exit → throw with the rendered command line (plus captured stderr/stdout when capturing). Under `--dry-run`: print `dry-run: <cmd> <args...>`, execute nothing. Command probe: `spawnSync(win32 ? "where" : "which", [cmd])` status 0.

Acquisition is naturally convergent: `npm i -g` re-run is a fast no-op; `cargo install` prints "Ignored, already installed" and exits 0.

---

## 6. Staging (resolving the assets root)

Assets are copied from a staged package root. Resolution order is strict:

1. **Local checkout** — `<sourceRoot>/<product.id>`, then `<sourceRoot>/<install.package ?? install.crate ?? id>`. Qualifies if it contains `package.json` OR a `skills/` dir. No cleanup. (`source: "local"` — local trees win so developers can install work-in-progress.)
2. **Git clone** — only when `install.type === "git-plugin"` and `install.repo` is set: `git clone --depth 1 <repo>` into a fresh `mkdtempSync(join(tmpdir(), "wicked-<cli>-<productId>-"))`. (`source: "git"`; temp cleaned up after the product finishes.)
3. **npm pack fallback** — requires `install.package`: `npm pack <pkg> --json --pack-destination <tmp>` → parse output for `filename` → `tar -xzf <tarball> -C <tmp>` → root is `<tmp>/package`. (`source: "npm-pack"`; temp cleaned up in `finally`, including on error.)

If no source resolves, the product still SUCCEEDS with the note `no package assets found for <CLI>` and zero asset counts — acquisition alone may be the whole install (e.g. wicked-crew). The staging source (`assets source: local|git|npm-pack`) is always recorded as a note.

**Copy filter** (every recursive copy): skip `.DS_Store`; skip any path containing a segment in `{.git, .next, .turbo, coverage, dist, node_modules, target}`. Copies use `cpSync(src, dest, { recursive: true, force: true, filter })` — re-runs converge by overwriting. Consequence: products must not ship skills inside a `dist/` directory (Appendix A, D-8).

---

## 7. Asset integration

### 7.1 Skills (the primary asset type)

**Discovery — recursive skill-root finding.** For each non-hidden directory under `<root>/skills`: if it directly contains `SKILL.md`, it is a skill root (atomic — do not descend into it); otherwise recurse until directories containing `SKILL.md` are found. Handles flat layouts (`skills/<name>/SKILL.md`) and nested trees (`skills/wicked-bus/{emit,init,…}/SKILL.md` — each leaf is its own skill root).

**Name resolution.** Read frontmatter `name:` from `SKILL.md` with `/^name:\s*["']?([^"'\n]+)["']?\s*$/m`. Then normalize:

```
if name startsWith "wicked-" OR name contains ":"  → keep as-is (already namespaced)
else → "<productId>-" + (name || relPathFromSkillsDir with path separators → "-")
```

**Destination.** `<cliHome>/skills/<sanitize(nextName)>` where `sanitize` maps `[:/\\]+` → `-`, any char outside `[A-Za-z0-9._-]` → `-`, trims leading/trailing dashes (colon removal doubles as Windows-reserved-char safety). Flat namespace — no per-product skill subdirectories.

**SKILL.md rewrite.** After copying, if the normalized name differs from the original, rewrite the copied `SKILL.md`'s `name:` line to `name: <nextName>` (unquoted). Never under `--dry-run`.

**Per-platform overrides.** A skill may ship `skills/<skill>/platform/<cli>/` content. Normative semantics for a script that selects per-platform content: when `platform/<cli>/` contains files they are PREFERRED — used INSTEAD of the skill's generic equivalents; when absent, fall back to generic content. (A v1 script that copies the whole skill-root tree verbatim — as the codex reference does — simply carries any `platform/<cli>/` subdir into the destination unchanged; that is conforming. Prefer-with-fallback *selection* is the v1.1 behavior.)

**Platform-override dir slug — fully specified, nothing to guess.** The `<cli>` token is **your script's own slug**: the exact same token that appears in `install-<cli>.ts` and in your `--<cli>-home` flag. Your script reads `skills/<skill>/platform/<cli>/`, e.g.:

- the codex reference's slug is `codex` → it reads `skills/<skill>/platform/codex/`;
- a `claude` script's slug is `claude` → it reads `skills/<skill>/platform/claude/`.

That is the whole rule. A team-owned script MAY *additionally* read other slugs of its own choosing for the config root it owns (for instance, a script serving a shared family home may also honor that family's name) — but that is the owning team's private choice, **not specified by this contract and not something you reproduce**. Your script reads exactly one slug: your own.

### 7.2 Agents and commands are NOT installed by any conforming script

The asset taxonomy this contract defines is **skills + mcp + hooks + bins** (§4). `agents/` and `commands/` are **not** in it. They are legacy directories from the pre-skills-only era; the products have since converted to skills-only (wicked-garden and wicked-testing ship no `agents/` or `commands/` dirs), and **no conforming install script — the codex reference included — copies them.** This is verified, not aspirational: the codex reference copies skills only (its asset counts are `{ skills }`), and the antigravity script does the same. There is no "grandfathered" script that still copies them.

- **Do not discover or copy `agents/` or `commands/`.** A script cloned from `install-codex.ts` inherits this for free — codex has no agents/commands copy path. Do not add one.
- **`agents`/`commands` are legacy report/marker keys only.** If you emit them, they are always `0`; a conforming script never sets them nonzero. The codex reference omits them entirely — it emits only `assets.skills` (§9). They persist in the schema solely so a v1 parser that happens to read `assets.agents`/`assets.commands` doesn't crash.
- **On install you MUST purge your product's own stale agents/commands left by prior-era installs (§12.4).** Because these dirs used to ship, upgrading from an old install can leave orphaned `agents/<productId>-*.md` and `commands/<productId>/` behind. Removing them is a **REQUIRED** install behavior (§12.4), ownership-gated so you never touch a foreign file.

**Do not add asset types beyond skills/mcp/hooks/bins.** There is no agents/commands copy path in the reference to model, and you must not invent one.

### 7.3 Home preparation

Before any copy: `mkdirSync` (recursive) the home plus its discovery subdirs, then verify writability (`accessSync(home, W_OK)`). If the CLI is neither on PATH nor has an existing home: log a warning and PROCEED — invoking the install script IS consent to create the home. Under `--dry-run`, log the mkdirs instead.

### 7.4 Failure isolation

- **Per product:** each product installs inside its own try/catch (codex `installOne` is normative). One failure → `success: false` entry; the loop continues. Temp staging dirs cleaned in `finally`.
- **Per target (v1.1, multi-config-dir CLIs):** a writability preflight fails ONE config dir cleanly (corporate-locked home, read-only mount); other targets proceed; per-target results surface in `actions[]`.
- **Per action (v1.1):** a corrupt `~/.claude.json` fails the MCP action, not the product's skill copies.

### 7.5 Config roots owned by another team (non-normative)

Some bundled scripts serve a config root by their own conventions — for example, the antigravity team's script targets the Gemini family's shared home (`~/.gemini`). **How any such script lays out its home is that team's business and is NOT specified by this contract.** You do not need to read those scripts, reproduce their layout, or reason about their internals to build your own; nothing in this document depends on them.

The only rules that bind you are the general ones stated elsewhere:

- **One owning script per config root (§2.1).** You never write into a config root another script already owns, so you never share a home with the antigravity script (or any other).
- **Your own home uses the standard destinations of §7.1** with `<cliHome>` = the root you own.
- If a genuinely separate integration ever needs the Gemini family with different assets, it takes its **own** root (e.g. `~/.gemini-wicked`) and is written from `install-codex.ts` + this document alone (§15) — it does not co-write `~/.gemini` and does not open another team's source.

---

## 8. Convergence semantics (v1.1 — the idempotency contract)

v1 convergence is overwrite-copy (conforming). v1.1 scripts implement the following. Re-run with unchanged inputs = fast no-op reported as success with an "already current" message.

### 8.1 Fast-path / upgrade / force, per product × target

- Marker entry version == staged package version (read from the staged `package.json` — the only version truth) AND all recorded `files[]` exist → **skip** (integrity-verified no-op) unless `--force`.
- Versions differ → **upgrade**: stage new version, install it, then **stale-sweep** — delete every path in the old marker `files[]` not present in the new set (each deletion passes the ownership check of §12.3). Then replace the marker entry. This is what removes a skill dir the new version dropped.
- `--force` → full reinstall even when current; additionally takes ownership in skill collisions (§8.6) and overwrites foreign MCP keys recording `prior` (§8.3).
- Compat shim (claude only): when installing wicked-testing, also write `<configDir>/skills/.wicked-testing-version` with the installed semver (downstream `wg-check` / `check --require` consumers read it). Listed in `files[]`, removed on uninstall.

### 8.2 Atomic write rule (all JSON the script owns or merges)

Every write to a shared config file (`~/.claude.json`, `settings.json`) and the marker: serialize → write `"<name>.wicked-tmp-<pid>-<rand>"` **in the same directory** (same filesystem ⇒ atomic rename) → `renameSync` over the destination. On Windows, `EPERM`/`EBUSY` from AV/indexer locks is retried 3× with 100ms backoff, then the action fails leaving the tmp file for inspection and the **original untouched**. Startup sweeps stale `*.wicked-tmp-*` files older than 1h in directories the script writes — matching only its own prefix.

### 8.3 mcpServers wiring (claude first; invariants apply to any CLI that adopts it)

**Adoption is opt-in and per-CLI; a CLI MUST NOT guess a target.** The invariants below (read-modify-write, atomic tmp+rename, backup, converge-per-server, `json-key` marker) are CLI-agnostic, but the **target location — config file path plus the top-level key that holds the server map — is NOT derivable and must never be inferred.** A CLI wires MCP only after its target is stated *in this section* and verified once against that CLI's actual runtime (the same one-time obligation recorded for claude in Appendix A, J-20). Until then the script MUST silently ignore the registry `mcp` block and keep surfacing `install.mcpInstructions` prose — what `install-codex.ts` and `install-antigravity.ts` do *toward the block* (verified: neither reads the block; the antigravity script emits the note and touches no MCP config file). **Claude's target is the only one specified so far.** The Gemini family has **no** specified MCP target, so the antigravity script does not wire MCP; a future adopter adds a "Gemini-family MCP target" line here (file + key, verified) before wiring — it does not invent `~/.gemini/????.json`. Hooks wiring (§8.4) follows the identical opt-in-with-explicit-target rule.

**Two distinct MCP mechanisms — do not conflate them.** "MCP wiring" is not one thing:

1. **Registry-block JSON-file wiring (this section).** Read-modify-write a config file's server map, driven by the registry `mcp` block (§4.1). This is the mechanism whose *target — file path + top-level key — is not derivable and must never be inferred*; it is opt-in per CLI and requires an explicit, verified target. **Claude adopts mechanism 1** (`~/.claude.json` → `mcpServers`).
2. **CLI-native subcommand registration.** Invoke the CLI's own MCP-registration command (e.g. an `mcp add` subcommand); the CLI owns its MCP store behind that subcommand, so there is **no config-file target to state or verify**, and the guess-a-target prohibition does not apply to it. **No bundled script uses mechanism 2 in its install flow today** — in particular the codex reference registers no MCP server during install: its `installOne`/`main` flow reads no `mcp` block and only surfaces `install.mcpInstructions` prose (§4.1). **Ignore the unwired mechanism-2 sketch in the codex source.** `install-codex.ts` *does* carry three helpers — `registerCodexMcp` (which would run `codex mcp add <id> -- <binaryPath>`), `codexMcpServerExists`, and `cargoBinaryPath` — but **nothing calls them**: they are unreferenced dead code (never reached from `installOne` or `main`), non-normative, and NOT part of the reference install flow. They are **not** a sanctioned template and must not be modeled on; a mechanism-2 adopter writes its own `<cli> mcp add` call from this section, not by copying those functions. A CLI whose runtime exposes such a subcommand MAY use this mechanism; if it does, that is the CLI team's own integration detail, not something this contract prescribes or that you model on another CLI.

**Which a new CLI should use.** If your CLI exposes an `mcp add`-style subcommand, mechanism 2 is the simplest, safest option — invoke `<cli> mcp add <server> -- <binaryPath>` for the `mcp-binary` products (e.g. wicked-estate) and never touch a config file. If your CLI has no such subcommand, you MAY adopt mechanism 1 after stating and verifying your JSON target **in this section**. Doing neither is always conforming: a script that wires no MCP simply surfaces `install.mcpInstructions` prose — which is exactly what the codex and antigravity references do. A future Gemini-family adopter, for instance, would pick one mechanism and document it here (a verified target line for mechanism 1, or its own `mcp add` call for mechanism 2) — it never invents `~/.gemini/????.json`.

Target file (claude): for the default `~/.claude` home, `~/.claude.json` (top-level `mcpServers` key — a file that also holds unrelated user state); for a target derived from `CLAUDE_CONFIG_DIR`/`--claude-home`, `<dir>/.claude.json` (Claude Code relocates its state file into the override dir; the implementer must verify this against the installed Claude Code version once and note the check in the PR — Appendix A, J-20).

1. **Read-modify-write, never clobber.** Add/replace ONLY the entries named in the product's `mcp` block; preserve every unknown top-level key and every mcpServers entry the script doesn't own.
2. **Abort on parse failure.** A corrupt config file fails the MCP action with "fix or remove `<file>` and re-run"; it is NEVER replaced with `{}`; the file stays byte-identical. Other asset types for the product still proceed.
3. **Atomic write** per §8.2. **Backup** before the first modification of a given file in a run: copy to `<configDir>/wicked-installer/backups/<basename>.<ISO-compact>.bak`; keep newest 5, prune older.
4. **Converge per server name:** absent → add; present and deep-equal desired → no-op; present and hash-matches our previous write (`wroteHash` in marker) → update to new desired; present and foreign → `collision-skipped` note, no write — unless `--force`, which records the foreign value as `prior` in the marker and overwrites.
5. **Tilde expansion** of `command`/`env` values per §4.1 at write time.
6. **Marker:** every added key recorded as a `json-key` record (§10.2) so uninstall can remove exactly it.
7. **Missing file tolerated:** create one containing only `{ "mcpServers": { ... } }`.

### 8.4 Hooks wiring (claude: `<configDir>/settings.json`, event-keyed arrays)

**Opt-in and per-CLI, same rule as §8.3.** A CLI wires hooks only after its hook config file and event model are stated here and verified against that CLI's runtime; until then it ignores the product's `hooks/` assets (recording a note) rather than guessing where they go. Claude's model — below — is `<configDir>/settings.json` with event-keyed arrays. No other CLI (codex, antigravity/gemini) has a specified hooks target yet, so none of them wire hooks today.

- Hook scripts and runtime siblings are NOT scattered into the config dir. The product payload (its `hooks/` plus sibling dirs the hooks/skills reference — e.g. wicked-testing's `lib/`, `scenarios/`, `schemas/`; wicked-garden's `scripts/`) is copied to the owned root `<configDir>/wicked-installer/products/<productId>/` (replace-on-install; recorded as one `dir` record).
- `${CLAUDE_PLUGIN_ROOT}` in every command string from the product's `hooks/hooks.json` is rewritten to that absolute payload root at merge time (the variable only exists for real plugin installs). This rewrite is also the **ownership key**: an entry is owned by product P iff its command contains `wicked-installer/products/<P>` (compare with normalized separators — marker stores forward slashes; live settings.json on Windows contains backslashes). Ownership is thus derivable from the entry itself and survives marker loss.
- Converge = **remove all owned entries for P, then insert the current desired set** — structurally incapable of duplication on re-run. Preserve all foreign matcher groups and unknown settings.json keys; parse-failure, backup, and atomicity rules of §8.2/§8.3 apply.

### 8.5 Skills convergence

v1.1: **replace-on-install** — delete the owned dest dir, then copy — so files removed upstream don't linger. Deletion is gated by ownership: the marker lists the dir, or (marker silent) a two-signal signature check — SKILL.md frontmatter `name:` matches AND the body/frontmatter references the product. A third-party skill squatting the name is never deleted (§8.6 applies instead).

### 8.6 Skill collisions (two products, one dest name)

Prefixing makes this rare by construction (and the vault/loom absorptions eliminated the known cases). Policy: **first installed wins.** The later product's copy action reports `collision-skipped` naming the owner (marker lookup, or signature check for unmanaged dirs). `--force` transfers ownership: dir replaced, old owner's marker `files[]` pruned, both reports carry notes. A dir matching neither marker nor signature (genuinely foreign) is never overwritten even with `--force` — hard `failed` action with a rename suggestion. Product teams own uniqueness of `wicked-*` skill names (Appendix A, D-6).

### 8.7 Bins

Post-acquisition verification: each declared bin resolvable via the PATH probe; cargo bins additionally checked at `~/.cargo/bin` / `%USERPROFILE%\.cargo\bin` with a PATH-hint note when found there but not on PATH. Verification failure is a note when assets landed; a missing binary the product cannot function without makes the report `failed`. (The registry has no `bins` field in this revision; probe the names the product's `install` spec implies — Appendix A, D-14.)

---

## 9. Report JSON & exit codes

### 9.1 v1 (frozen — what codex emits)

With `--json`, print exactly one pretty-printed (2-space) JSON object to stdout:

```jsonc
{
  "<cli>Home": "/Users/me/.codex",       // key literally named codexHome / geminiHome / claudeHome ...
  "reports": [
    {
      "productId": "wicked-testing",
      "displayName": "Wicked Testing",
      "success": true,
      "skipped": false,                   // true only for install.type manual|binary
      "message": "Wicked Testing: installed (skills=48)",
      "assets": { "skills": 48 },          // codex emits ONLY skills — no agents/commands keys
      "notes": ["assets source: local"]
    }
  ]
}
```

Without `--json`: one `[ok|manual|failed] <message>` line per product plus indented notes.

**Caution for JSON consumers:** on a real (non-dry-run) v1 install, child processes run with inherited stdio, so npm/cargo output can precede the report on stdout. The report is the LAST complete JSON object on stdout; consumers parse from the tail. `--dry-run --json` output is guaranteed pure. v1.1 scripts SHOULD switch acquisition spawns to captured stdio when `--json` is set, making stdout pure in all modes.

### 9.2 v1.1 additive keys (consumers must tolerate absence AND presence)

```jsonc
{
  "<cli>Home": "...",
  "contract": "1.1",
  "verb": "install",                     // install | status | uninstall
  "dryRun": false,
  "configDirs": ["..."],                 // multi-target CLIs; <cli>Home stays = primary
  "reports": [{
    "productId": "...", "displayName": "...",
    "success": true, "skipped": false, "message": "...",
    "version": "0.7.3",                  // staged/acquired version when known
    "assets": { "skills": 12, "agents": 0, "commands": 0, "mcp": 1, "hooks": 1 },
    "actions": [ { "kind": "copy-skill|write-json-key|merge-hook|acquire|migrate-removed|collision-skipped|restore-prior|remove",
                   "target": "...", "result": "ok|planned|skipped|failed", "detail": "..." } ],
    "notes": []
  }]
}
```

`assets.mcp`/`assets.hooks`/`assets.bins` are additive keys inside the existing object — a v1 parser that reads only `assets.skills` keeps working. **No conforming script copies agents or commands (§7.2)**, so `assets.agents`/`assets.commands` are either absent (the codex reference emits only `skills`) or always `0` (a script that keeps them for v1-parser compatibility, as the claude reference does); they are never nonzero. `skills` is the only asset count guaranteed present. `status`/`uninstall` use the same envelope with verb-appropriate entries. Exit-1-if-any-failed applies with and without `--json`.

---

## 10. Install marker

### 10.1 v1 (as shipped by install-codex — remains readable forever)

Path: `<cliHome>/wicked-installer/<cli>-install.json`

```jsonc
{
  "installedAt": "2026-07-10T12:00:00.000Z",
  "codexHome": "/Users/me/.codex",
  "products": [
    { "id": "wicked-testing", "success": true, "skipped": false,
      "assets": { "skills": 48 }, "notes": ["..."] }   // codex records only skills
  ]
}
```

v1 semantics: records the LAST run only (whole-file overwrite — a known defect, Appendix A D-5/J-3). Written even under partial failure; skipped under `--dry-run` (logged instead). A marker without `markerVersion` is legacy: `status` reports `state: "legacy-marker"` with the note "exact uninstall unavailable — re-run install to upgrade bookkeeping"; `uninstall` falls back to heuristics (§12.3). The first v1.1 install run rewrites it as v2, preserving legacy product entries it can still verify on disk.

### 10.2 v2 (v1.1 — the files manifest that makes exact uninstall possible)

One marker **per config dir** the script writes into (uninstall bookkeeping must be local to the dir it describes). Path unchanged: `<configDir>/wicked-installer/<cli>-install.json`.

```jsonc
{
  "markerVersion": 2,
  "cli": "claude",
  "configDir": "/Users/x/.claude",
  "installerVersion": "0.2.0",
  "updatedAt": "2026-07-10T12:00:00.000Z",
  "products": {
    "wicked-testing": {
      "version": "0.7.3",
      "installedAt": "2026-07-10T12:00:00.000Z",
      "source": "local",                       // local | npm-pack | git
      "lastResult": "installed",               // installed | partial | failed
      "assets": { "skills": 48, "agents": 0, "commands": 0, "mcp": 0, "hooks": 1 },
      "files": [
        { "kind": "dir",  "path": "skills/wicked-testing-acceptance" },
        { "kind": "file", "path": "skills/.wicked-testing-version" },
        { "kind": "dir",  "path": "wicked-installer/products/wicked-testing" },
        { "kind": "json-key", "file": "~/.claude.json", "pointer": "/mcpServers/wicked-estate",
          "wroteHash": "sha256:...", "prior": null },
        { "kind": "hooks-entry", "file": "settings.json", "event": "Stop",
          "ownerMatch": { "commandContains": "wicked-installer/products/wicked-testing" } }
      ],
      "notes": []
    }
  }
}
```

Rules:
- **The marker is a statement of what exists on disk, not of success.** Written on every non-dry run, including mixed-success and failed runs.
- **Per-product merge, keyed by id** — never whole-file overwrite. Read existing marker (v1 or v2), upsert entries for THIS run's products, preserve all others, write back atomically (§8.2).
- **Incremental flush:** rewrite after *each product* completes; a crash loses at most the in-flight product's record.
- **Journal rule:** `files[]` is appended as operations succeed, so a product failing halfway has `lastResult: "partial"` and a `files[]` listing exactly the partial footprint — `uninstall` can clean it, re-`install` converges forward.
- `path`/`file` values: configDir-relative when inside the config dir; absolute (with `~/` shorthand) otherwise. Stored with forward slashes; normalized via `path.join` on read.
- `json-key`: `pointer` is an RFC 6901 JSON Pointer into `file`. `wroteHash` = `sha256:` + hash of the canonical JSON (sorted keys) of the value written. `prior` = the pre-existing value (non-null only when `--force` replaced a foreign value), enabling restore on uninstall.
- `hooks-entry`: owned hook objects are identified by `ownerMatch.commandContains` (§8.4) — ownership survives marker loss.
- Record paths as CREATED (post-sanitization destination names), never source paths.

---

## 11. Multi-config-dir resolution (claude) & detection

### 11.1 Claude target resolution (policy lives in ONE place — the claude script)

Precedence — first non-empty level wins as the FULL target set:

1. `--claude-home <dir>` (repeatable; each occurrence adds a target). Explicit flag ⇒ **trusted**: identity check skipped, created if absent, single/multi exactly as given.
2. `CLAUDE_CONFIG_DIR` env — **authoritative and EXCLUSIVE when set** (matches Claude Code's actual runtime: when set, Claude Code reads only that dir; installing into `~/.claude` too would produce dead files). Split on **`path.delimiter` plus `,`** (`;`+`,` on Windows, `:`+`,` elsewhere — never bare `:` on win32, `C:\Users\...` would shatter). Each path tilde-expanded. Trusted at install time (fresh empty dir must work); re-verified by `status`.
3. Probe the default home, identity-filtered: **`~/.claude` only** — the sole config root Claude Code actually reads, with its state file `~/.claude.json` alongside it. **Two-signal rule:** dir exists AND any-of identity markers present — `settings.json`, `plugins/`, `projects/`. Bare-dir existence is never enough. No other default dir is probed: Claude Code reads only `~/.claude` (+ `~/.claude.json`), or `CLAUDE_CONFIG_DIR` exclusively when set (step 2), so assets written into any other location — `~/.config/claude`, a developer's `~/alt-configs/.claude`, etc. — would never load. A no-flag, no-env install therefore targets at most `~/.claude`.
4. Nothing passes ⇒ `install` creates `~/.claude` (selection is consent, matching codex); `status`/`uninstall` exit 2.

Fan-out: skills, hooks, payload dirs, version stamps, and the marker are written **per config dir** (independent per-target success/failure, §7.4). The MCP file per target is defined in §8.3. Report: `claudeHome` = primary target; `configDirs` = full list (§9.2).

This supersedes the additive `configDirs()` currently in `src/installer.ts:13-22` (Appendix A, J-6).

### 11.2 Detection heuristics (script preflight AND central picker)

Two independent signals, both reported: `binOnPath` (`where` on win32 / `command -v` elsewhere, 2–3s timeout) and `homeDetected` (root + ANY-of identity markers):

| CLI | bin | home root(s) | identity markers (ANY-of) |
|---|---|---|---|
| claude | `claude` | §11.1 chain | `settings.json`, `plugins/`, `projects/` |
| codex | `codex` | `$CODEX_HOME` or `~/.codex` | `config.toml`, `config.json`, `auth.json`, `plugins/` |
| gemini family — Antigravity + Gemini CLI, **one owner: `install-antigravity`** (§2.1) | `gemini`, `antigravity-cli` | `$GEMINI_HOME` or `~/.gemini` | `config.json`, `auth/`, `settings.json` |
| cursor | — | `~/.cursor` | `mcp.json`, `User/`, `extensions/`, `settings.json` |
| kiro | `kiro` | `~/.kiro` | `config.json`, `settings.json` |
| opencode | `opencode` | — | bin only |
| pi | — | `~/.pi` | `agent` |

**The Gemini family is one detection target with one owner.** The row above describes a single shared home (`~/.gemini`) served by a single script (`install-antigravity.ts`, §2.1). `gemini` and `antigravity-cli` are two *bins* that both signal the same script — not a discriminator that selects between two scripts, because only one exists. Detection therefore never produces a separate `gemini` entry alongside `antigravity`: `detector.ts` `DETECT_SPECS` carries the `antigravity` slug (whose `bins` already include `gemini`) and **no** separate `gemini` slug. The picker offers the Gemini home exactly once, preselected when either bin or the home markers fire (§14).

GitHub Copilot: **no install script exists and none is planned** — prior art removed the `~/.github/skills` drop as dangerous (dotfile collision; `gh copilot` doesn't read it). Since the picker only offers CLIs with install scripts, Copilot is structurally never offered; do not resurrect it.

---

## 12. Verbs (v1.1)

### 12.1 `install` (default)

The v1 flow (§5–7), plus: marker v2 bookkeeping (§10.2), MCP/hooks wiring where supported (§8.3/§8.4), stale-sweep on upgrade (§8.1), and the **REQUIRED stale-artifact purge (§12.4)**.

### 12.2 `status`

Read-only, always safe — never stages or acquires. Per product × target it reports:

- **`installedVersion`** — the marker entry's `version` (fall back to legacy `.wicked-<product>-version` stamps). May be `unknown`: v1 markers and legacy stamps often omit it.
- **`registryVersion`** — *cheaply resolvable* means **without staging or acquiring** (status does neither). The registry Product shape carries **no** product-level version field (`install.version` is only a cargo pin, present on a minority of products). So the only version a status run can read for free is a pinned `install.version`; when the product does not pin one, `registryVersion` is `unknown` and status does **not** attempt to discover it. It is reported informationally when known and is **never required** to reach a `state` verdict.
- **`state: current | stale | missing | partial | legacy-marker | corrupt`** — derived from marker + on-disk integrity, **independent of any version comparison**, so it is always computable:
  - `corrupt` — the target's marker is unparseable.
  - `legacy-marker` — a v1 marker lists the product but has no `files[]` manifest (note: "exact uninstall unavailable — re-run install to upgrade bookkeeping").
  - `missing` — no marker entry for the product in this target.
  - `partial` — the entry's `lastResult` is `"partial"`.
  - `stale` — **integrity drift**: any recorded `dir`/`file` path is absent, **or** a `json-key` pointer no longer holds a value hashing to its `wroteHash` (also surfaced as `modified-externally`). *Optionally* also `stale` when **both** `installedVersion` and a cheaply-resolvable `registryVersion` are known and differ (version-behind) — an enhancement, not a requirement, precisely because `registryVersion` is usually `unknown`.
  - `current` — entry present, `lastResult: "installed"`, and every recorded path/key intact.

Integrity spot-checks feed the `stale` verdict: every recorded `files[]` path exists; SKILL.md present and non-empty for skill dirs; `json-key` pointers still hold a value matching `wroteHash`. Re-verifies identity markers on env-var-derived dirs. Exit 0 when the query succeeds (stale is information, not failure); exit 1 on I/O/parse failure; exit 2 when the CLI isn't present (§3.3). This status model is fully specified here: version is informational and `state` follows marker `lastResult` + on-disk integrity, **never** an unavailable `registryVersion`.

### 12.3 `uninstall`

`uninstall <ids...>` or `uninstall --all` (= every product in the marker). Removes EXACTLY what install created, config entries first, then payload:

- `json-key`: current value hash == `wroteHash` ⇒ delete the key — or restore `prior` when recorded. Hash mismatch ⇒ leave it, report `skipped-modified` ("user changed this; remove `<pointer>` manually"). Atomicity per §8.2.
- `hooks-entry`: remove all entries matching `ownerMatch` from the named event arrays; drop empty matcher groups; never touch foreign entries.
- `dir`/`file`: exists ⇒ ownership/signature check (§8.5) ⇒ remove recursively. Never remove shared discovery dirs (`skills/`, `agents/`, `commands/`) themselves; prune `wicked-installer/products/<id>` and backups per retention.
- Then: legacy sweeps (§12.4), delete the product's marker entry; delete the marker (and `wicked-installer/` if empty) when the last product goes.
- **Binaries are NOT removed by default** — npm/cargo globals are machine-scoped and shared across CLIs; uninstalling one CLI's integration must not break another. `--purge-binaries` opts in to `npm rm -g` / `cargo uninstall` with a warning listing other CLIs whose markers still reference the product.
- **v1/legacy markers — heuristic mode:** remove only product-prefixed paths this convention itself would have created (`<cliHome>/skills/<productId>-*` plus pass-through skill names recorded in marker asset notes, `<cliHome>/commands/<productId>/`, `<cliHome>/agents/<productId>-*`), each gated by the signature check; NEVER touch shared JSON config files (report `manual-review` — we can't know we wrote them); flag the report entry `"heuristic": true`.
- Supports `--dry-run` (prints the exact removal list, including `skipped-modified` verdicts) and `--json`.

### 12.4 Stale-artifact purge (REQUIRED on install; also runs on uninstall)

**Purging your product's own prior-era artifacts is a REQUIRED install behavior, not optional cleanup.** Products used to ship `agents/` and `commands/` and were namespaced differently; upgrading from such an install leaves orphans behind (e.g. stale `~/.claude/agents/<productId>-*.md` and `~/.claude/commands/<productId>/`). On every install — and as part of uninstall — a conforming script MUST remove **its own product's** stale artifacts, and MUST NOT touch anything it cannot prove it owns.

**What to remove.** For each product being installed, sweep the artifacts a prior era of this convention could have created for that product:

- pre-skills-only `agents/<productId>-*.md` (product-prefixed agent files);
- `commands/<productId>/` (the product's command-namespace dir);
- earlier-era skill dirs the product no longer ships (bare-name or renamed dirs — e.g. after the vault→testing / loom→garden absorptions);
- any product-owned tree recorded in an **older marker's `files[]`** that the current install no longer produces (this is the §8.1 stale-sweep on upgrade).

**How ownership is proven — two sources, each safe to run unconditionally:**

1. **Marker `files[]` (exact).** The marker (§10.2) lists every path this convention created for the product; **that manifest is precisely what enables *exact* removal.** On upgrade, delete every old-marker `files[]` entry absent from the new set; on uninstall, delete the recorded set. Each deletion still passes the §8.5/§12.3 ownership check.
2. **Product-prefixed naming heuristic (fallback for artifacts a marker never recorded — a legacy/v1 marker, or a pre-marker install).** Only paths this convention itself would have created for the product qualify: `<cliHome>/agents/<productId>-*.md`, `<cliHome>/commands/<productId>/`, and product-signature-matching skill dirs. Each is gated by the two-signal signature check (§8.5) before removal.

**Never touch a foreign file.** A path matching neither the marker nor the product-prefixed/signature test is left alone. Shared discovery dirs (`skills/`, `agents/`, `commands/`) are never themselves removed — only product-owned entries inside them. Shared JSON config files are never swept heuristically (report `manual-review`; §12.3).

**Reporting.** Every removal (planned or done) is a `migrate-removed` action (§9.2): `result: "planned"` under `--dry-run` (which writes nothing), `result: "ok"` on a real run — so `--dry-run` prints the exact purge list before anything is deleted.

(Illustration, non-normative: the claude reference performs this on install — it sweeps `commands/<id>/` and `agents/<id>-*.md`, plus pre-0.3 bare-name skill dirs and the old hardcoded `~/.claude/plugins/wicked-garden/` tree, each signature-gated, emitting `migrate-removed`. Its slug-specific set is its own; the REQUIRED behavior for *your* script is the product-prefixed rule above.)

---

## 13. Dry-run guarantees

1. **Zero writes outside the OS temp dir.** No mkdir under the CLI home, no marker write, no config-file writes, no backups, no `npm i -g`/`cargo install`, no PATH mutations. Print `dry-run: <action>` lines for every command (with cwd when set), mkdir, tree copy (`copy <src> -> <dest>`), and marker write.
2. **Staging into temp (git clone, npm pack) is permitted and encouraged** in dry-run — it's what makes reported asset counts real. Where a script skips staging (codex skips npm-pack today — conforming v1), v1.1 scripts must say so: note `asset counts unavailable (dry-run, npm-pack source)` rather than reporting confident zeros. Only local-checkout sources are guaranteed accurate in v1.
3. `--dry-run --json` emits the **same report schema** with `dryRun: true` and every action's `result: "planned"` — the central picker parses dry and real runs identically. Stdout is guaranteed pure JSON (this is the validated conformance check).
4. Dry-run reproduces failures detectable without writing: unknown product ids, missing cargo toolchain, unreadable registry, corrupt target JSON ⇒ same exit codes as a real run.

---

## 14. Central picker (`src/index.ts` becomes the dispatcher)

Flow: existing product/bundle picker → dependency resolution (resolver.ts unchanged) → CLI detection (§11.2 signals + glob of `dist/install-*.js` next to `dist/index.js`) → multi-select CLIs → spawn each selected script **sequentially** as `process.execPath dist/install-<cli>.js <ids...> --json` (never rely on shebangs — Windows), appending `--skip-binaries` for the 2nd..nth, passing through `--dry-run`/`--force` → parse each stdout (tail JSON object; tolerate v1 shape, absent verbs, absent mcp support) → render one aggregate product × CLI summary table → exit 1 if any script exited nonzero or any report failed; treat exit 2 as "CLI not present", not an error. A script whose stdout fails to parse is reported failed with its raw tail attached.

**Offer rule:** a CLI is offered iff `dist/install-<cli>.js` exists — shipping the script IS registering with the picker; no adapters registry exists. Preselected when either detection signal fires; shown unchecked with "not detected — home will be created" when neither fires (selecting it is allowed). A CLI with no install script is never offered.

**Shared-home de-duplication (§2.1).** At most one script owns a config root, so the picker never offers the same home twice and never runs two scripts into one dir in a single pass. The bundled scripts satisfy this by construction — `codex`→`~/.codex`, `claude`→its §11.1 chain, `antigravity`→`~/.gemini`; there is no `install-gemini.js`. A CLI team MUST NOT ship a second script targeting a home an existing script owns. If the picker ever discovers two scripts whose resolved default homes collide, it offers only the one whose slug is the config-root owner (the antigravity script for `~/.gemini`) and drops the other with a warning — the §2.1 invariant is enforced at the picker, not silently violated.

`detector.ts` marker sets upgrade to the §11.2 table; its `DETECT_SPECS` carries no separate `gemini` entry — the Gemini home is detected under the `antigravity` slug alone (§2.1/§11.2), so the two-owners-one-home offer can never occur. Its `isProductInstalled` hardcoded `~/.claude` probes (including the Windows-impossible `wicked-testing:acceptance-testing` colon dir, detector.ts:79) are superseded by reading markers via each script's `status --json` where available.

---

## 15. How to register your CLI (checklist)

1. Copy `src/install-codex.ts` to `src/install-<cli>.ts`. Keep it self-contained: no imports from other `src/` modules, `node:` builtins only, no npm deps.
2. Rename the home plumbing: `Options.codexHome` → `<cli>Home`; default `$<CLI>_HOME` then `~/.<cli>`; flags `--<cli>-home`/`--<cli>-home=`; report key `<cli>Home` (literal `<cli>` + `Home`, no transformation — a hyphenated slug like `gemini-wicked` gives the valid key `gemini-wickedHome`; the report `*Home` pattern accepts the same lowercase/digit/hyphen slug set as the marker `cli` field, §9/Appendix B.1); marker `<cli>-install.json`; temp-dir prefix `wicked-<cli>-`; help text; "Installing X for <CLI>..." strings; the PATH-probe command name.
3. Set your platform-override dir: `skills/<skill>/platform/<cli>/` where `<cli>` is your own slug (§7.1). Prefer-with-fallback selection is the v1.1 behavior; a v1 clone that copies the skill tree verbatim carries the subdir along.
4. Map assets to YOUR CLI's layout — adjust §7 destinations, not the discovery/normalization algorithms or the flag surface. Fixed rules for a new script: (a) confirm your `--<cli>-home` default does not resolve to a config root an existing bundled script already owns (§2.1); (b) do NOT copy `agents/`/`commands/` — the codex reference has **no** such copy path, so a clone inherits this for free; if you emit those keys at all, report `agents: 0, commands: 0` (§7.2); (c) on install, perform the **REQUIRED stale-artifact purge** of your product's own prior-era `agents/<id>-*.md` and `commands/<id>/` orphans (§12.4), ownership-gated and `--dry-run`-reported; (d) to wire MCP/hooks you must first add and verify your CLI's target file+key per §8.3/§8.4 — otherwise ignore the registry `mcp` block and product `hooks/` assets (surface the prose note), which is conforming; a CLI whose runtime has a native `mcp add` subcommand may instead use mechanism 2 (§8.3).
5. Apply the Windows spawn rule (§1.1) to every npm/npx invocation.
6. Add `dist/install-<cli>.js` to the chmod list in `package.json` `scripts.build`.
7. Do not touch other CLIs' `install-*.ts` files or `registry.json` product entries.
8. Conformance check before PR: `npm run build`, then —
   - `node dist/install-<cli>.js --all --dry-run --json` → exits 0, stdout is exactly one JSON object with `<cli>Home` + `reports[]`;
   - `node dist/install-<cli>.js wicked-garden --dry-run` → resolves `requires` (bus, testing ordered first);
   - `node dist/install-<cli>.js bogus-id` → exits 1 with `unknown product: bogus-id`;
   - `--products a,b`, `--<cli>-home=/tmp/x`, and bare-flag rejection behave per §3.
9. PR checklist: cross-platform (`where`/`which` gated, `path.join` throughout, `.cmd` spawn rule), unknown-registry-field tolerant, per-product failure isolation, idempotent re-run, marker written, `--force`/`--skip-binaries` accepted; v1.1 extensions (verbs/mcp/marker-v2) optional but flag-compatible if present.

---

## Appendix A — Decisions

Carried from the codex reference (accidental or ambiguous behavior, resolved):

- **D-1 — `--json` stdout purity.** v1 conforming as-is (inherited stdio interleaves); consumers parse the trailing JSON object. v1.1 scripts SHOULD capture acquisition stdio when `--json` is set.
- **D-2 — `--force` is a parsed no-op in v1.** Keep accepting; v1.1 gives it the §8.1/§8.6 meaning. Never repurpose.
- **D-4 — no "CLI not present" exit for install.** Invoking an install script is consent; the script warns and creates the home. Detection belongs to the picker and to `status`.
- **D-5 — v1 marker is last-run-only.** Accidental defect; fixed by marker v2 per-product merge. v2 implementations MUST merge.
- **D-6 — skill-name pass-through** (`wicked-*` / `:`-containing names kept unprefixed): product teams own uniqueness of `wicked-*` skill names; §8.6 handles the residual collision risk.
- **D-8 — `dist` in the copy-skip set:** deliberate; products must not ship skills inside `dist/`.
- **D-9 — agents/commands are not an installed asset type (§7.2).** No conforming script copies `agents/`/`commands/` — the codex reference copies skills only (asset counts `{ skills }`), and so does the antigravity script. The `agents`/`commands` report/marker keys persist solely for v1-parser compatibility; they are absent (codex) or `0` (claude), never nonzero. Prior-era orphans left by old installs are removed by the REQUIRED stale-artifact purge (§12.4), not re-created. (This supersedes the earlier "grandfathered copying" framing, which described behavior that no bundled script performs.)
- **D-11 — design-status products install when explicitly named.** Intentional escape hatch; `manual` type makes it harmless.
- **D-12 — bare value-flags error as "unknown option".** Accidental phrasing, correct outcome (reject over silent default). Keep.
- **D-14 — bins verification** deferred to §8.7/`status` probing; no registry `bins` field in this revision.

Judged in this synthesis (conflict → decision → why):

- **J-1 — Skeleton.** Design A's document structure and v1 codification adopted wholesale; Design B's operational semantics grafted into §8, §10–13. Why: A is the document a third-party team implements from; B is the correctness of what they implement. They are complementary, not competing.
- **J-2 — Marker v2 record format: B's structured objects** over A's `json:path#keypath` string grammar. Why: strings cannot carry `wroteHash`/`prior`, which are what make hash-guarded deletion and foreign-value restore possible; structured records need no ad-hoc parser.
- **J-3 — Marker keying: object keyed by product id (B)**, not array upsert (A). Why: upsert-by-id is the operation; an object makes it O(1) and unambiguous. `markerVersion: 2` discriminates from v1's array shape, so v1 readability is unaffected.
- **J-4 — One marker per config dir (B).** Why: uninstall bookkeeping must live in the dir it describes, or a removed alt-config leaves orphaned records. Degenerates to A's single marker for single-home CLIs.
- **J-5 — Exit code 2 exists, but only for v1.1 `status`/`uninstall` (B)**; `install` never exits 2 (A's D-4). Why: satisfies both "codex as shipped is conforming" (codex has no verbs, uses 0/1 only) and the seed contract's useful not-present signal, where it is genuinely a query answer rather than a refusal.
- **J-6 — `CLAUDE_CONFIG_DIR` is exclusive-when-set** (both drafts agree), split on `path.delimiter` + `,` (B). Why: matches Claude Code's actual runtime (additive install produces dead files in `~/.claude`); bare-`:` splitting shatters `C:\` paths on Windows — verified defect in the current `src/installer.ts:13-22`, which this supersedes.
- **J-7 — wicked-estate `WICKED_ESTATE_DB = ~/.wicked-estate/graph.db` (A)**, not B's `~/.wicked/graph.db`. Why: verified against source — the binary's own default is `DEFAULT_DB = ".wicked-estate/graph.db"` (main.rs:30, cwd-relative); A's value is that default home-anchored, so users who ever ran the server from `$HOME` keep their data; B's value invents a new location. All four DBs pinned explicitly so the collision panic (main.rs:259) cannot fire — that part is B's, kept.
- **J-8 — Platform overrides: prefer-with-fallback is the v1.1 normative selection semantics (§7.1).** The slug is always the script's own `<cli>` token (codex → `platform/codex/`). How any team-owned script (e.g. antigravity) handles overrides for the config root it owns is that team's concern and is not specified or measured here.
- **J-9 — Windows `.cmd` spawn rule (B) is REQUIRED for new scripts (§1.1).** Real Node ≥ 20.12 behavior (CVE-2024-27980): npm/npx `.cmd` shims need `{ shell: true }` + pre-quoted args. The codex reference's `run()` omits it — retroactively failing codex would break the no-breakage guarantee, so it stays a documented v1 caveat there. The fully inlined `winQuote` recipe in §1.1 is the reference a new script copies; you never read another script to get it.
- **J-10 — Report: v1 envelope frozen (both), v1.1 additive keys (B — `contract`, `verb`, `dryRun`, `configDirs`, `version`, `actions[]`, `assets.mcp/hooks`)** plus A's tail-parse consumer rule. Why: additive-only keeps every v1 parser working; `actions[]` is what makes dry-run and uninstall auditable.
- **J-11 — Hooks ownership by payload-root substring (B)** over A's exact-command-string match. Why: survives argument changes across versions and survives marker loss (ownership derivable from the entry itself); exact-string matching breaks on the first arg tweak.
- **J-12 — Skills convergence: replace-on-install (B) in v1.1;** codex's overwrite-copy stays conforming v1. Why: overwrite leaves upstream-deleted files behind; replace is the only convergent semantics — gated by ownership so squatting third-party dirs are safe.
- **J-13 — Dry-run: A's honest-limits documentation + B's guarantees.** Temp-dir staging permitted in dry-run; zero writes outside temp; "counts unavailable" note over confident zeros (v1.1 wording; codex's current zeros+note stay conforming v1).
- **J-14 — `github-binary` Windows mapping specified now (B)** rather than deferred (A's D-10): `%LOCALAPPDATA%\wicked\bin`, `.exe` suffix, no chmod. Why: no registry product uses the type yet, which is exactly why the spec must close the hole before one does.
- **J-15 — Uninstall never removes binaries by default; `--purge-binaries` opts in (B).** Why: npm/cargo globals are machine-scoped and shared across CLIs.
- **J-16 — Verb detection on the first positional (both drafts, same rule stated two ways).** Registry constraint added: product ids must never equal verb names (all are `wicked-*`).
- **J-17 — Copilot: never offered (B's hard rule, softened mechanism).** The offer rule (script-existence) makes it structural; the spec additionally records why no script should be written (`~/.github/skills` collision, verified prior-art removal).
- **J-18 — `src/installer.ts` direct git-plugin path is superseded by the dispatcher.** Its `ASSET_DIRS` shrinks to `["skills"]` when the claude script lands (it currently re-creates orphans testing is deleting, installer.ts:180); the working-tree changes stay until then. The `configDirs()` additive semantics are superseded per J-6.
- **J-19 — B's open questions resolved:** (Q1) `.claude.json` relocates to `<dir>/.claude.json` under `CLAUDE_CONFIG_DIR`/`--claude-home` — codified with a one-time implementation-verification obligation in §8.3; (Q2) wicked-interactive's missing tarball `skills/` — the staging chain (local → git → npm-pack) already covers it once the registry entry gains a repo URL; upstream `files` fix preferred; no contract change; (Q3) wicked-garden's `uv sync` — out of the asset taxonomy; surfaced as a note ("run /wicked-garden:setup"), no new manifest field; (Q4) resolved by J-6.
- **J-20 — D-13 (multi-home reporting) resolved:** `<cli>Home` = primary target, plus v1.1 `configDirs[]`; explicit `--<cli>-home` forces exactly the given target set.
- **J-21 — Config-root ownership is exclusive (§2.1), resolving the shared-`~/.gemini` P0.** Two install scripts MUST NOT share a config root. The Gemini family (Antigravity + Gemini CLI) both read `~/.gemini`, so it is one config root with one owner — a team-owned script — and there is nothing for this contract to split. There is no `install-gemini.ts`; `gemini` is a detection alias, not a slug. Why exclusivity over per-CLI namespacing / refuse-foreign-marker: the marker (§10), skills-convergence (§8.5), and collision (§8.6) semantics all assume a single owner per dir. Enforced in code: `detector.ts` `DETECT_SPECS` carries no separate `gemini` entry (folded into `antigravity`, whose `bins` include `gemini`), and the picker de-dupes colliding homes to the config-root owner (§14). **This contract does not specify how the antigravity script populates `~/.gemini` — that layout is its team's, and a new author never reads it (§7.5).**
- **J-22 — Registry-block MCP wiring (mechanism 1) is opt-in with an explicit, verified per-CLI target (§8.3/§8.4).** No CLI may infer a config-file target/key for mechanism 1; until one is stated in the doc and verified against the CLI's runtime, the `mcp` block and `hooks/` assets are ignored toward that mechanism. **Verified reality:** the codex reference reads no `mcp` block and registers no MCP server in its install flow — it only surfaces `install.mcpInstructions` prose; antigravity does the same. (The codex source contains `registerCodexMcp`/`codexMcpServerExists`/`cargoBinaryPath`, but they are unreferenced dead code never reached by `installOne`/`main`, so no registration executes — non-normative, and not a mechanism-2 template to copy; §8.3.) So **no bundled script performs MCP wiring by either mechanism today**, and that is fully conforming. Claude's JSON-file target (`~/.claude.json` → `mcpServers`) is the only mechanism-1 target specified. A CLI whose runtime exposes a native `mcp add`-style subcommand MAY use **mechanism 2** (no config-file target to state or verify) — that is the CLI team's own integration detail, not prescribed here and not modeled on another CLI's script. Why: the config-file target is the one thing that determines whether *mechanism-1* wiring corrupts a foreign config, so guessing it is unacceptable and non-adoption is always safe; mechanism 2 carries no such risk because the CLI owns its own store.
- **J-23 — Detection maps the shared Gemini home to its single owner (§11.2/§14).** The picker offers `~/.gemini` once, via the antigravity script; `gemini` and `antigravity-cli` are two bins signalling the same script, not a discriminator between two scripts (only one exists). If two scripts with colliding resolved homes are ever discovered, the picker offers only the config-root owner and drops the other with a warning — so "both offered, both preselected, both writing the same dir" cannot occur.

---

## Appendix B — JSON Schemas (draft 2020-12)

The authoritative machine-readable copies live beside this document:

- `schemas/install-report.schema.json` — the `--json` stdout envelope (§9).
- `schemas/install-marker.schema.json` — install marker v2 (§10.2).
- `schemas/registry-mcp.schema.json` — the per-product registry `mcp` block (§4.1).

The definitions below are reproduced inline for reading convenience; the files are canonical (they carry `examples`).

### B.1 Report (`--json` stdout)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wicked.garden/schemas/install-report.json",
  "title": "wicked-installer per-CLI install script report",
  "type": "object",
  "description": "Exactly one property matching ^[a-z][a-z0-9-]*Home$ MUST be present (e.g. codexHome, claudeHome, geminiHome). The key is the <cli> slug (same lowercase/digit/hyphen set as the marker `cli` field) + literal `Home`, no transformation — a hyphenated slug like `gemini-wicked` yields `gemini-wickedHome`. v1 emits only that key plus reports[]; all other top-level keys are v1.1-optional.",
  "patternProperties": {
    "^[a-z][a-z0-9-]*Home$": { "type": "string" }
  },
  "properties": {
    "contract": { "type": "string", "enum": ["1.1"] },
    "verb": { "type": "string", "enum": ["install", "status", "uninstall"] },
    "dryRun": { "type": "boolean" },
    "configDirs": { "type": "array", "items": { "type": "string" } },
    "reports": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["productId", "displayName", "success", "skipped", "message", "assets", "notes"],
        "properties": {
          "productId": { "type": "string" },
          "displayName": { "type": "string" },
          "success": { "type": "boolean" },
          "skipped": { "type": "boolean" },
          "message": { "type": "string" },
          "version": { "type": "string" },
          "heuristic": { "type": "boolean", "description": "uninstall only: removal used v1-marker heuristics" },
          "assets": {
            "type": "object",
            "required": ["skills"],
            "description": "Counts by installed asset type. Taxonomy: skills + mcp + hooks + bins. Only skills is guaranteed present (the codex reference emits it alone). agents/commands are LEGACY keys — no conforming script installs agents or commands, so they are absent or always 0, never nonzero.",
            "properties": {
              "skills": { "type": "integer", "minimum": 0 },
              "mcp": { "type": "integer", "minimum": 0 },
              "hooks": { "type": "integer", "minimum": 0 },
              "bins": { "type": "integer", "minimum": 0 },
              "agents": { "type": "integer", "minimum": 0, "description": "legacy; absent or 0, never nonzero" },
              "commands": { "type": "integer", "minimum": 0, "description": "legacy; absent or 0, never nonzero" }
            },
            "additionalProperties": false
          },
          "actions": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["kind", "target", "result"],
              "properties": {
                "kind": { "type": "string", "enum": ["copy-skill", "write-json-key", "merge-hook", "acquire", "migrate-removed", "collision-skipped", "restore-prior", "remove"] },
                "target": { "type": "string" },
                "result": { "type": "string", "enum": ["ok", "planned", "skipped", "failed"] },
                "detail": { "type": "string" }
              },
              "additionalProperties": false
            }
          },
          "notes": { "type": "array", "items": { "type": "string" } }
        },
        "additionalProperties": true
      }
    }
  },
  "required": ["reports"],
  "additionalProperties": true
}
```

### B.2 Install marker v2

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wicked.garden/schemas/install-marker-v2.json",
  "title": "wicked-installer install marker v2",
  "type": "object",
  "required": ["markerVersion", "cli", "configDir", "updatedAt", "products"],
  "properties": {
    "markerVersion": { "const": 2 },
    "cli": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "configDir": { "type": "string" },
    "installerVersion": { "type": "string" },
    "updatedAt": { "type": "string", "format": "date-time" },
    "products": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["installedAt", "lastResult", "files"],
        "properties": {
          "version": { "type": "string" },
          "installedAt": { "type": "string", "format": "date-time" },
          "source": { "type": "string", "enum": ["local", "npm-pack", "git"] },
          "lastResult": { "type": "string", "enum": ["installed", "partial", "failed"] },
          "assets": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 0 } },
          "files": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "required": ["kind", "path"],
                  "properties": {
                    "kind": { "type": "string", "enum": ["dir", "file"] },
                    "path": { "type": "string", "description": "configDir-relative when inside the config dir, else absolute (~/ shorthand allowed); forward slashes always" }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": ["kind", "file", "pointer", "wroteHash"],
                  "properties": {
                    "kind": { "const": "json-key" },
                    "file": { "type": "string" },
                    "pointer": { "type": "string", "description": "RFC 6901 JSON Pointer" },
                    "wroteHash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
                    "prior": { "description": "value replaced under --force; null when the key was newly added" }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": ["kind", "file", "event", "ownerMatch"],
                  "properties": {
                    "kind": { "const": "hooks-entry" },
                    "file": { "type": "string" },
                    "event": { "type": "string" },
                    "ownerMatch": {
                      "type": "object",
                      "required": ["commandContains"],
                      "properties": { "commandContains": { "type": "string" } },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false
                }
              ]
            }
          },
          "notes": { "type": "array", "items": { "type": "string" } }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

(v1 markers — `{ installedAt, <cli>Home, products: [...] }` with no `markerVersion` — remain valid input to `status`/`uninstall` forever; they are not re-specified here because they are frozen as shipped.)

### B.3 Registry `mcp` block (per-product, optional)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wicked.garden/schemas/registry-mcp-block.json",
  "title": "registry.json product mcp block",
  "type": "object",
  "description": "Optional per-product map of MCP server name to stdio launch spec. All registry consumers MUST tolerate its presence (and that of any other unknown field).",
  "minProperties": 1,
  "additionalProperties": {
    "type": "object",
    "required": ["command"],
    "properties": {
      "command": { "type": "string", "description": "bare executable name (PATH-resolved by the CLI host) or a path; leading ~ expanded at wire time" },
      "args": { "type": "array", "items": { "type": "string" }, "default": [] },
      "env": { "type": "object", "additionalProperties": { "type": "string" }, "description": "leading ~ in values expanded at wire time" }
    },
    "additionalProperties": false
  }
}
```

---

*Files this spec governs:* `src/install-codex.ts` (the **single normative v1 reference** — team-owned by the codex team; read it, don't edit it), `src/install-antigravity.ts` (team-owned, **NOT normative** — its `~/.gemini` home and internal choices belong to its team and are not specified here; you never need to read it), `src/install-claude.ts` (team-owned first v1.1 implementation — the normative v1.1 behavior lives in this doc + `schemas/`, not in that file), `registry.json` (gains the §4.1 `mcp` block on wicked-estate), `src/index.ts` (becomes §14 dispatcher), `src/installer.ts` + `src/detector.ts` (superseded semantics per J-6/J-18/§14), `package.json` (build chmod list), `INTERFACE.md` (this text), `schemas/*.schema.json` (Appendix B canonical copies).
