import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guide = readFileSync(join(root, "docs", "INSTALL.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// wicked-installer#77: the guide says which releases it was checked against. Its installer version must be this
// package's, so an installer release cannot leave the line naming an older one.
test("the install guide names the installer version it ships with", () => {
  const line = guide.split("\n").find((l) => l.startsWith("This guide was checked against"));
  assert.ok(line, "docs/INSTALL.md has its 'checked against' line");
  const m = /wicked-installer (\d+\.\d+\.\d+) and wicked-crew (\d+\.\d+\.\d+)\./.exec(line);
  assert.ok(m, `the line names both versions: ${line}`);
  assert.equal(m[1], pkg.version);
});
