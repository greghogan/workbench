import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { test } from "vitest";
import { runCoverage, subprocessCoverage } from "../scripts/test-coverage.mjs";
import { bundleOptions } from "../scripts/bundle-options.mjs";

test("coverage keeps final evidence and cleans selected scratch storage after success or failure", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-coverage-storage-"));
  const root = join(temporary, "project");
  const external = join(temporary, "external");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "bundle"));
    mkdirSync(join(root, "workbench"));
    mkdirSync(join(root, "tests"));
    mkdirSync(external);
    writeFileSync(join(external, "keep"), "unrelated build product");
    symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "junction");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(root, "src/value.js"),
      "export function value() { return 42; }\nexport function unused() { return 0; }\n",
    );
    writeFileSync(join(root, "src/main.ts"), 'import { value } from "./value.js"; console.log(value());');
    writeFileSync(join(root, "src/skills.ts"), 'export function skill() { return "fixture"; }');
    const shipped = new Map();
    for (const name of ["main", "skills"]) {
      await build(bundleOptions(root, name));
      const contents = readFileSync(join(root, `bundle/${name}.cjs`), "utf8");
      assert.equal(contents.includes("sourceMappingURL="), false);
      shipped.set(name, contents);
    }
    writeFileSync(
      join(root, "vitest.config.mjs"),
      'export default { test: { include: ["tests/value.test.mjs"], reporters: ["json"], outputFile: "coverage/tests.json", coverage: { provider: "v8", include: ["src/*.js"], reporter: ["json"] } } };',
    );
    for (const outcome of ["pass", "test failure", "coverage failure"]) {
      const summaryPath = join(root, "coverage/coverage-summary.json");
      const previousSummary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : undefined;
      writeFileSync(
        join(root, "tests/value.test.mjs"),
        `import {test,expect} from "vitest"; import {spawnSync} from "node:child_process"; import {readFileSync} from "node:fs"; import {fileURLToPath} from "node:url"; import {value} from "../src/value.js"; test("value", () => {
          const bundle = new URL("../bundle/main.cjs", import.meta.url);
          expect(readFileSync(bundle, "utf8")).toContain("sourceMappingURL=");
          const cli = spawnSync(process.execPath, [fileURLToPath(bundle)], {encoding: "utf8"});
          expect(cli.status).toBe(0); expect(cli.stdout.trim()).toBe("42");
          expect(value()).toBe(${outcome === "test failure" ? "0" : "42"});
        });`,
      );
      writeFileSync(
        join(root, "workbench/quality.json"),
        JSON.stringify({
          coverage: { lines: 0, statements: 0, branches: 0, functions: outcome === "coverage failure" ? 100 : 0 },
        }),
      );
      // Use both an external build root and the direct runner's ordinary local default.
      const run = () => runCoverage(root, outcome === "test failure" ? undefined : external);
      if (outcome === "pass") await run();
      else
        await assert.rejects(
          run,
          outcome === "test failure" ? /tests or coverage collection failed/ : /functions coverage .* below 100/,
        );
      assert.deepEqual(readdirSync(external), ["keep"]);
      if (outcome === "test failure") assert.deepEqual(readdirSync(join(root, "build")), []);
      const results = JSON.parse(readFileSync(join(root, "coverage/tests.json"), "utf8"));
      assert.equal(results.success, outcome !== "test failure");
      assert.equal(Object.hasOwn(results, "coverageMap"), false);
      assert.equal(results.numTotalTests, 1);
      const suite = results.testResults[0];
      assert.equal(resolve(suite.name), join(root, "tests/value.test.mjs"));
      assert.ok(suite.endTime >= suite.startTime);
      const assertion = suite.assertionResults[0];
      assert.equal(assertion.title, "value");
      assert.equal(assertion.status, outcome === "test failure" ? "failed" : "passed");
      assert.ok(assertion.duration >= 0);
      if (outcome === "test failure") assert.ok(assertion.failureMessages.length > 0);
      assert.equal(existsSync(summaryPath), true);
      if (outcome === "test failure") assert.equal(readFileSync(summaryPath, "utf8"), previousSummary);
      assert.ok(
        readdirSync(join(root, "coverage")).every((name) =>
          ["coverage-final.json", "coverage-summary.json", "tests.json"].includes(name),
        ),
      );
      for (const [name, contents] of shipped)
        assert.equal(readFileSync(join(root, `bundle/${name}.cjs`), "utf8"), contents);
      if (outcome !== "test failure") {
        const measured = JSON.parse(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"));
        assert.ok(Object.keys(measured).every((path) => path.startsWith(join(root, "src"))));
        assert.ok(Object.values(measured).every((file) => file.path.startsWith(join(root, "src"))));
      }
    }
    assert.equal(readFileSync(join(external, "keep"), "utf8"), "unrelated build product");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("coverage merges direct imports and disposable CLI copies without crediting changed sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-coverage-merge-"));
  const copy = mkdtempSync(join(tmpdir(), "workbench-coverage-copy-"));
  const { mergeCoverage } = await import("../scripts/test-coverage.mjs");
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, NODE_V8_COVERAGE: "", ...env },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(copy, "src"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "junction");
    writeFileSync(
      join(root, "src/direct.js"),
      "export function direct() { return 42; }\nexport function neverDirect() { return 0; }\n",
    );
    writeFileSync(
      join(root, "src/copied.js"),
      "export function copied() { return 7; }\nexport function neverCopied() { return 0; }\nconsole.log(copied());\n",
    );
    writeFileSync(join(root, "src/changed.js"), "export function changed() { return 1; }\nconsole.log(changed());\n");
    writeFileSync(join(root, "src/unimported.js"), "export function unimported() { return 99; }\n");
    const { copyFileSync } = await import("node:fs");
    mkdirSync(join(copy, "bundle"));
    for (const name of ["copied", "changed"]) {
      await build({
        entryPoints: [join(root, `src/${name}.js`)],
        outfile: join(root, `bundle/${name}.cjs`),
        bundle: true,
        format: "cjs",
        platform: "node",
        sourcemap: "inline",
      });
      copyFileSync(join(root, `bundle/${name}.cjs`), join(copy, `bundle/${name}.cjs`));
    }
    writeFileSync(
      join(copy, "src/changed.js"),
      readFileSync(join(root, "src/changed.js"), "utf8").replace("return 1", "return 2"),
    );
    await build({
      entryPoints: [join(copy, "src/changed.js")],
      outfile: join(copy, "bundle/changed.cjs"),
      bundle: true,
      format: "cjs",
      platform: "node",
      sourcemap: "inline",
    });
    writeFileSync(
      join(root, "direct.test.mjs"),
      'import { test, expect } from "vitest"; import { direct } from "./src/direct.js"; test("direct result", () => expect(direct()).toBe(42));',
    );
    writeFileSync(
      join(root, "vitest.config.mjs"),
      'export default { test: { include: ["direct.test.mjs"], coverage: { provider: "v8", include: ["src/*.js"], reporter: ["json"], reportsDirectory: "coverage/unit", clean: false } } };',
    );
    run([resolve(import.meta.dirname, "../node_modules/vitest/vitest.mjs"), "run", "--coverage"]);
    const temporary = join(root, "coverage/tmp");
    for (const name of ["copied", "changed"]) run([join(copy, `bundle/${name}.cjs`)], { NODE_V8_COVERAGE: temporary });
    // The source trees are gone by reporting time, as in update/setup integration tests.
    rmSync(copy, { recursive: true, force: true });
    writeFileSync(join(root, "coverage/cli.json"), JSON.stringify(await subprocessCoverage(temporary, root)));
    const map = mergeCoverage(
      [join(root, "coverage/unit/coverage-final.json"), join(root, "coverage/cli.json")],
      join(root, "coverage"),
      {},
    );
    for (const name of ["direct", "copied"]) {
      const file = map.fileCoverageFor(join(root, `src/${name}.js`));
      assert.equal(file.toSummary().functions.total, 2);
      const counts = Object.entries(file.fnMap).map(([id, fn]) => [fn.name, file.f[id]]);
      assert.ok(
        counts.some(([fn, count]) => fn === name && count > 0),
        JSON.stringify(counts),
      );
      assert.ok(counts.filter(([fn]) => fn.startsWith("never")).every(([, count]) => count === 0));
    }
    for (const name of ["changed", "unimported"])
      assert.equal(map.fileCoverageFor(join(root, `src/${name}.js`)).toSummary().functions.covered, 0);
    assert.throws(
      () =>
        mergeCoverage([join(root, "coverage/coverage-final.json")], join(root, "coverage/strict"), { functions: 100 }),
      /below 100/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});
