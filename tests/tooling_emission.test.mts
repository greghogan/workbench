import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { buildTooling, parseToolingOperation } from "../scripts/build-tooling.mts";
import {
  maintainerOutput,
  maintainerOutputs,
  toolingArtifact,
  toolingIgnoreBlock,
  toolingIgnoreEnd,
  toolingIgnores,
} from "../scripts/tooling-artifacts.mts";
import { sourceMapErrors } from "../src/source-maps.ts";

test("a standalone's first emission uses newly authored dependencies, then passes parity without another build", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-tooling-order-"));
  try {
    for (const path of ["scripts", "scripts/maintenance", "examples", "bin", "tests/fixtures"])
      mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, "scripts/maintenance/edits.mts"),
      'import { value } from "./plan.mjs"; export const observed = value;\n',
    );
    writeFileSync(join(root, "scripts/maintenance/plan.mts"), 'export { value } from "./operation.mjs";\n');
    writeFileSync(join(root, "scripts/maintenance/operation.mts"), 'export const value = "fresh authored value";\n');
    writeFileSync(
      join(root, "scripts/maintenance/operation.mjs"),
      'export const value = "stale bundled dependency";\n',
    );
    writeFileSync(join(root, "scripts/maintenance/plan.mjs"), 'export const value = "stale generated value";\n');
    for (const name of ["ci-docker", "ci-workbench"])
      writeFileSync(join(root, `tests/fixtures/${name}.mts`), "export {};\n");
    await buildTooling({ root, operation: "build" });
    const entry = join(root, "scripts/maintenance/edits.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const module = await import(process.argv[1]); process.stdout.write(module.observed);",
        pathToFileURL(entry).href,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "fresh authored value");
    const emitted = readFileSync(entry, "utf8");
    await buildTooling({ root, operation: "verify" });
    assert.equal(readFileSync(entry, "utf8"), emitted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source-only development helpers become executable without repairing tracked runtime files", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-tooling-classes-"));
  try {
    for (const path of ["scripts", "scripts/maintenance", "examples", "bin", "tests/fixtures"])
      mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, "scripts/runtime.mts"), 'export const value = "fresh";\n');
    writeFileSync(join(root, "scripts/runtime.mjs"), 'export const value = "stale";\n');
    writeFileSync(join(root, "scripts/maintenance/main.mts"), 'process.stdout.write("maintainer ready");\n');
    writeFileSync(join(root, "scripts/bundle-options.mts"), 'export const value: string = "compiled dependency";\n');
    writeFileSync(
      join(root, "scripts/build-bundle.mts"),
      'import { value } from "./bundle-options.mjs"; process.stdout.write(value);\n',
    );
    for (const config of ["eslint", "vitest"])
      writeFileSync(join(root, `${config}.config.mts`), 'export default { name: "generated configuration" };\n');
    for (const name of ["ci-docker", "ci-workbench"])
      writeFileSync(
        join(root, `tests/fixtures/${name}.mts`),
        'import { value } from "../../scripts/bundle-options.mjs"; process.stdout.write(value);\n',
      );
    assert.equal(existsSync(join(root, "scripts/build-bundle.mjs")), false);
    await buildTooling({ root, operation: "prepare-development" });
    assert.equal(readFileSync(join(root, "scripts/runtime.mjs"), "utf8"), 'export const value = "stale";\n');
    assert.equal(existsSync(join(root, "scripts/maintenance/main.mjs")), true);
    const result = spawnSync(process.execPath, [join(root, "scripts/maintenance/main.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "maintainer ready");
    for (const entry of [
      "scripts/build-bundle.mjs",
      "tests/fixtures/ci-docker.mjs",
      "tests/fixtures/ci-workbench.mjs",
    ]) {
      const executed = spawnSync(process.execPath, [join(root, entry)], { encoding: "utf8" });
      assert.equal(executed.status, 0, executed.stdout + executed.stderr);
      assert.equal(executed.stdout, "compiled dependency");
    }
    for (const config of ["eslint", "vitest"]) {
      const loaded = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const config = await import(process.argv[1]); process.stdout.write(config.default.name);`,
          pathToFileURL(join(root, `${config}.config.mjs`)).href,
        ],
        { encoding: "utf8" },
      );
      assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
      assert.equal(loaded.stdout, "generated configuration");
    }
    await assert.rejects(buildTooling({ root, operation: "verify" }), /runtime.mjs is stale/);
    await buildTooling({ root, operation: "build" });
    await buildTooling({ root, operation: "verify" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git ignores declared development outputs while preserving their sources and runtime helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-tooling-ignores-"));
  try {
    writeFileSync(join(root, ".gitignore"), readFileSync(new URL("../.gitignore", import.meta.url)));
    execFileSync("git", ["init", "--quiet", root]);
    const outputs = maintainerOutputs.map((pattern) => pattern.replace("**/*", "nested/module"));
    const retained = [
      "scripts/clean.mjs",
      "scripts/check-bootstrap.mjs",
      "scripts/check-node-runtime.mjs",
      "scripts/ci-plan.mjs",
      "scripts/prepare-development.mjs",
      "examples/languages/c/scripts/check.mjs",
      "bin/workbench.mjs",
      "bin/bundle-runtime.cjs",
    ];
    const candidate = "scripts/.runtime.mjs.12345678-1234-4123-8123-123456789abc.tmp";
    const paths = [
      ...outputs,
      candidate,
      ...outputs.map((path) => path.slice(0, -4) + (path.endsWith(".cjs") ? ".cts" : ".mts")),
      ...retained,
      "scripts/unrelated.tmp",
    ];
    const ignored = execFileSync("git", ["-C", root, "check-ignore", "--no-index", "--stdin"], {
      input: paths.join("\n") + "\n",
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.deepEqual(ignored, [...outputs, candidate]);
    assert.ok(outputs.every(maintainerOutput));
    assert.ok(retained.every((path) => !maintainerOutput(path)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tooling operations reject ambiguous and unknown flags before any build runs", () => {
  assert.equal(parseToolingOperation([]), "build");
  assert.equal(parseToolingOperation(["--check"]), "verify");
  assert.equal(parseToolingOperation(["--maintainers-only"]), "prepare-development");
  assert.equal(parseToolingOperation(["--help"]), "help");
  assert.throws(() => parseToolingOperation(["--check", "--maintainers-only"]), /cannot be combined/);
  assert.throws(() => parseToolingOperation(["--chek"]), /Unknown option/);
  assert.throws(() => parseToolingOperation(["unexpected-root"]), /Unexpected argument/);
  assert.equal(toolingArtifact("tests/fixtures/ci-docker.mts").emission, "bundle");
  assert.equal(toolingArtifact("scripts/build-tooling.mts").output, null);
});

test("ignore verification rejects obsolete rules and build updates only its owned block", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-tooling-ignore-policy-"));
  try {
    const stale =
      "private-before/\n" +
      toolingIgnoreBlock.replace(toolingIgnoreEnd, "/scripts/obsolete.mjs\n" + toolingIgnoreEnd) +
      "private-after/\n";
    const path = join(root, ".gitignore");
    writeFileSync(path, stale);
    await assert.rejects(buildTooling({ root, operation: "verify" }), /ignore policy is stale/);
    await assert.rejects(buildTooling({ root, operation: "prepare-development" }), /ignore policy is stale/);
    assert.equal(readFileSync(path, "utf8"), stale);
    await buildTooling({ root, operation: "build" });
    assert.equal(readFileSync(path, "utf8"), "private-before/\n" + toolingIgnoreBlock + "private-after/\n");
    await buildTooling({ root, operation: "verify" });
    assert.throws(() => toolingIgnores(toolingIgnoreBlock + toolingIgnoreBlock), /one complete owned block/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real emitted ESM and CommonJS helpers retain source-map coverage before and after generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-emission-documentation-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "map.md"), "- `scripts/esm.mts`: ESM.\n- `scripts/common.cts`: CommonJS.\n");
    writeFileSync(join(root, "scripts/esm.mts"), "export const answer: number = 42;\n");
    writeFileSync(join(root, "scripts/common.cts"), "export = { answer: 42 };\n");
    assert.deepEqual(sourceMapErrors(root, "map.md", ["scripts"]), []);
    await buildTooling({ root, operation: "build" });
    assert.deepEqual(sourceMapErrors(root, "map.md", ["scripts"]), []);
    await buildTooling({ root, operation: "verify" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
