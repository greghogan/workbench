import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "outer-project", version: "1.0.0", license: "MIT" }),
    );
    for (const [name, source] of [
      ["direct", 'module.exports = require("transitive");'],
      ["transitive", "module.exports = 42;"],
      ["unused", "module.exports = 0;"],
    ] as const) {
      const directory = join(root, "node_modules", required(name, "Fixture value name"));
      mkdirSync(directory, { recursive: true });
      const entry = name === "direct" ? "dist/private/index.js" : "index.js";
      if (name === "direct") {
        mkdirSync(join(directory, "dist"));
        writeFileSync(join(directory, "dist/package.json"), JSON.stringify({ type: "commonjs", sideEffects: false }));
        mkdirSync(join(directory, "dist/private"));
        writeFileSync(
          join(directory, "dist/private/package.json"),
          JSON.stringify({ name: "direct/private", private: true, license: "MIT" }),
        );
      }
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, version: "1.0.0", license: "MIT", main: entry }),
      );
      writeFileSync(join(directory, entry), required(source, "Fixture value source"));
      writeFileSync(
        join(directory, name === "direct" ? "license" : "LICENSE"),
        `Original ${name} permission notice.\n`,
      );
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
    const manifest = join(root, "node_modules/direct/package.json"),
      original = readFileSync(manifest, "utf8");
    writeFileSync(manifest, JSON.stringify({ type: "commonjs" }));
    assert.throws(() => bundleLicenses(root, inputs), /cannot identify bundled package/);
    writeFileSync(manifest, original);
    rmSync(join(root, "node_modules/transitive/LICENSE"));
    assert.throws(() => bundleLicenses(root, inputs), /transitive@1.0.0: identify its license/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
