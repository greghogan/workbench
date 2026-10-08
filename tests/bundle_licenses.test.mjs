import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { test } from "vitest";
import { bundleLicenses } from "../scripts/bundle-licenses.mjs";

test("distribution notices follow the actual bundled dependency graph and reject missing licenses", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-bundle-licenses-"));
  try {
    mkdirSync(join(root, "workbench"));
    writeFileSync(join(root, "workbench/config.toml"), '[licenses]\nallow=["MIT"]\n');
    writeFileSync(join(root, "main.js"), 'console.log(require("direct"));\n');
    for (const [name, source] of [
      ["direct", 'module.exports = require("transitive");'],
      ["transitive", "module.exports = 42;"],
      ["unused", "module.exports = 0;"],
    ]) {
      const directory = join(root, "node_modules", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, version: "1.0.0", license: "MIT", main: "index.js" }),
      );
      writeFileSync(join(directory, "index.js"), source);
      writeFileSync(join(directory, "LICENSE"), `Original ${name} permission notice.\n`);
    }
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["main.js"],
      bundle: true,
      platform: "node",
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(result.metafile.inputs);
    const notices = bundleLicenses(root, inputs);
    for (const name of ["direct", "transitive"]) assert.ok(notices.includes(`Original ${name} permission notice.\n`));
    assert.ok(!notices.includes("unused"));
    writeFileSync(join(root, "workbench/config.toml"), '[licenses]\nallow=["ISC"]\n');
    assert.throws(() => bundleLicenses(root, inputs), /license.*needs policy review/);
    writeFileSync(join(root, "workbench/config.toml"), '[licenses]\nallow=["MIT"]\n');
    rmSync(join(root, "node_modules/transitive/LICENSE"));
    assert.throws(() => bundleLicenses(root, inputs), /transitive@1.0.0: identify its license/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
