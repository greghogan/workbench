import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as zlib from "node:zlib";
import { test } from "vitest";
import { Module, createRequire } from "node:module";
import loadBundle from "../bin/bundle-runtime.cjs";
import { bundleArtifacts, bundleCompression, bundleFormats } from "../scripts/bundle-artifacts.mjs";

test("compressed bundles execute offline with ordinary CommonJS exports, resolution, and caching", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-bundle-compression-")));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "bundle"));
    copyFileSync(resolve(import.meta.dirname, "../bin/bundle-runtime.cjs"), join(root, "bin/bundle-runtime.cjs"));
    writeFileSync(join(root, "bundle/dependency.cjs"), "module.exports = 42;");
    const source = Buffer.from(
      'globalThis.executions = (globalThis.executions ?? 0) + 1; module.exports = { value: require("./dependency.cjs"), resolved: require.resolve("./dependency.cjs"), cache: require.cache[__filename] === module, filename: __filename, directory: __dirname }; if (require.main === module) console.log("main");',
    );
    for (const compression of Object.keys(bundleFormats) as (keyof typeof bundleFormats)[]) {
      if (compression === "zstd" && typeof Reflect.get(zlib, "zstdCompressSync") !== "function") {
        assert.throws(() => bundleArtifacts("main", source, compression), /built-in Zstandard support/);
        writeFileSync(
          join(root, "bundle/main.cjs"),
          'require("../bin/bundle-runtime.cjs")(module, __filename, "zstd", require);',
        );
        const result = spawnSync(process.execPath, ["bundle/main.cjs"], { cwd: root, encoding: "utf8" });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /built-in Zstandard support/);
        continue;
      }
      const artifacts = bundleArtifacts("main", source, compression);
      assert.deepEqual(artifacts, bundleArtifacts("main", source, compression));
      for (const [path, contents] of artifacts) writeFileSync(join(root, "bundle", path), contents);
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          'const first = require("./bundle/main.cjs"); console.log(JSON.stringify({ ...first, cached: first === require("./bundle/main.cjs"), executions: globalThis.executions }));',
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        value: 42,
        resolved: join(root, "bundle/dependency.cjs"),
        cache: true,
        filename: join(root, "bundle/main.cjs"),
        directory: join(root, "bundle"),
        cached: true,
        executions: 1,
      });
      const direct = spawnSync(process.execPath, ["bundle/main.cjs"], { cwd: root, encoding: "utf8" });
      assert.equal(direct.status, 0, direct.stderr);
      assert.equal(direct.stdout.trim(), "main");
      writeFileSync(join(root, `bundle/main.cjs.${bundleFormats[compression]}`), "corrupt payload");
      const broken = spawnSync(process.execPath, ["bundle/main.cjs"], { cwd: root, encoding: "utf8" });
      assert.notEqual(broken.status, 0);
      assert.ok(broken.stderr.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle compression defaults to Brotli and rejects invalid selections", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-bundle-option-"));
  try {
    mkdirSync(join(root, "workbench"));
    const path = join(root, "workbench/config.toml");
    writeFileSync(path, "schema_version=1\n");
    assert.equal(bundleCompression(root), "brotli");
    for (const compression of Object.keys(bundleFormats) as (keyof typeof bundleFormats)[]) {
      writeFileSync(path, `[bundle]\ncompression="${compression}"\n`);
      assert.equal(bundleCompression(root), compression);
    }
    for (const value of ['"invalid"', '["brotli"]', '"__proto__"']) {
      writeFileSync(path, `[bundle]\ncompression=${value}\n`);
      assert.throws(() => bundleCompression(root), /Unknown bundle.compression/);
    }
    assert.throws(
      () => bundleArtifacts("main", readFileSync(import.meta.filename), "invalid"),
      /Unknown bundle.compression/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped runtime preserves module context and rejects unsupported or corrupt payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-runtime-contract-"));
  const filename = join(root, "main.cjs");
  try {
    writeFileSync(join(root, "dependency.cjs"), "module.exports = 42;");
    const localRequire = createRequire(filename);
    const source = Buffer.from(
      'module.exports = { value: require("./dependency.cjs"), filename: __filename, directory: __dirname };',
    );
    for (const compression of Object.keys(bundleFormats) as (keyof typeof bundleFormats)[]) {
      if (compression === "zstd" && typeof Reflect.get(zlib, "zstdCompressSync") !== "function") continue;
      for (const [path, bytes] of bundleArtifacts("main", source, compression)) writeFileSync(join(root, path), bytes);
      const target = new Module(filename);
      loadBundle(target, filename, compression, localRequire);
      assert.deepEqual(target.exports, { value: 42, filename, directory: root });
      writeFileSync(`${filename}.${bundleFormats[compression]}`, "corrupt payload");
      assert.throws(() => {
        loadBundle(new Module(filename), filename, compression, localRequire);
      });
    }
    assert.throws(() => {
      loadBundle(new Module(filename), filename, "unknown", localRequire);
    }, /Unknown bundle compression/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
