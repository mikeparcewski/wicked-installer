import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const guide = readFileSync(new URL("../docs/INSTALL.md", import.meta.url), "utf8");
const mac = guide.split("## macOS install")[1].split("## Windows install")[0];
const windows = guide.split("## Windows install")[1];
const block = (section, heading) => section.split(heading)[1].match(/```bash\n([\s\S]*?)```/)[1];

for (const [name, section, heading] of [
  ["macOS", mac, "### 3. Limit processes per pod"],
  ["WSL2", windows, "### 4. Limit processes per pod"],
]) test(`${name} provision script appends kubelet args through a drop-in (#70)`, () => {
  const script = block(section, heading);
  assert.match(script, /mkdir -p \/etc\/rancher\/k3s\/config\.yaml\.d/);
  assert.match(script, /cat > \/etc\/rancher\/k3s\/config\.yaml\.d\/wicked-pids\.yaml/);
  assert.match(script, /kubelet-arg\+:\n\s+- "pod-max-pids=4096"/);
  assert.doesNotMatch(script, />\s*\/etc\/rancher\/k3s\/config\.yaml(?:\s|$)/m);
});

for (const [step, heading, expected] of [
  [1, "### 1. Install the prerequisites", 'export PATH="/stub brew/python@3.12/libexec/bin:$PATH"'],
  [4, "### 4. Run the installer", 'export PATH="$HOME/.local/bin:$PATH"'],
]) test(`macOS step ${step} PATH append is idempotent (#71)`, { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wi-guide-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "brew"), `#!/bin/sh\nprintf '%s\\n' "/stub brew/python@3.12"\n`, { mode: 0o755 });
  // Execute only the guide's assignment and profile append, never its installs or sign-ins.
  const lines = block(mac, heading).split("\n").filter((line) => line.startsWith("PY312=") || line.includes(">> ~/.zprofile"));
  assert.ok(lines.some((line) => line.includes(">> ~/.zprofile")));
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", [...lines, ...lines].join("\n")], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, BASH_ENV: "/dev/null" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(home, ".zprofile"), "utf8").trim().split("\n"), [expected]);
});

test("macOS explains zsh login shells and the non-login zshrc alternative (#71)", () => {
  assert.match(mac, /`~\/\.zprofile` is read by zsh[^.]*login shell/);
  assert.match(mac, /non-login zsh[\s\S]*~\/\.zshrc/);
});

test("WSL2 step 6 explains PATH before the block and exports it before serving (#71)", () => {
  const section = windows.split("### 6. Install and start")[1].split("### 7.")[0];
  assert.ok(section.indexOf("Ubuntu's own `~/.profile`") < section.indexOf("```bash"));
  assert.deepEqual(block(windows, "### 6. Install and start").trim().split("\n"), [
    "npx -y wicked-installer@latest install wicked-crew wicked-interactive",
    'export PATH="$HOME/.local/bin:$PATH"',
    "wicked-crew serve",
  ]);
});

test("guide explains garden setup is for personal Claude Code sessions, not crew (#64)", () => {
  assert.match(guide, /"Run \/wicked-garden-core setup in Claude Code[^"]*"\. That step is for using Wicked Garden in your own Claude Code sessions; Wicked Crew doesn't need it\./);
});
