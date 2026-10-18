import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { test } from "vitest";
import { runCoverage, subprocessCoverage, type CoverageTimings } from "../scripts/test-coverage.mjs";
import type { NodeCoverageReport } from "../scripts/node-coverage-reports.mjs";
import { bundleOptions } from "../scripts/bundle-options.mjs";
import { buildTooling } from "../scripts/build-tooling.mjs";

test("coverage keeps final evidence and cleans selected scratch storage after success or failure", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-coverage-storage-")));
  const root = join(temporary, "project");
  const external = join(temporary, "external");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "bundle"));
    mkdirSync(join(root, "workbench"));
    mkdirSync(join(root, "tests"));
    mkdirSync(join(root, "languages"));
    writeFileSync(join(root, "languages/index.toml"), "# inherited language definitions\n");
    mkdirSync(join(root, "collections"));
    writeFileSync(join(root, "collections/index.toml"), "# pinned collection dependencies\n");
    symlinkSync(external, join(root, "workbench/.collections"), "junction");
    writeFileSync(join(root, ".pnpmfile.cjs"), "// managed dependency storage\n");
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
    writeFileSync(join(root, "src/launcher.ts"), 'export function launch() { return "launcher fixture"; }');
    const shipped = new Map<string, string>();
    for (const name of ["main", "skills", "launcher"]) {
      await build(bundleOptions(root, name));
      const contents = readFileSync(join(root, `bundle/${name}.cjs`), "utf8");
      assert.equal(contents.includes("sourceMappingURL="), false);
      shipped.set(name, contents);
    }
    writeFileSync(
      join(root, "vitest.config.mjs"),
      'export default { test: { include: ["tests/value.test.mjs"], setupFiles: ["tests/setup.mjs"], reporters: ["json"], outputFile: "coverage/tests.json", coverage: { provider: "v8", include: ["src/*.js"], reporter: ["json"] } } };',
    );
    writeFileSync(
      join(root, "tests/setup.mjs"),
      "process.env.NODE_V8_COVERAGE = process.env.WORKBENCH_SUBPROCESS_COVERAGE;\n",
    );
    for (const outcome of ["pass", "test failure", "coverage failure", "invalid report"]) {
      const summaryPath = join(root, "coverage/coverage-summary.json");
      const previousSummary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : undefined;
      writeFileSync(
        join(root, "tests/value.test.mjs"),
        `import {test,expect} from "vitest"; import {spawnSync} from "node:child_process"; import {existsSync,readFileSync,writeFileSync} from "node:fs"; import {fileURLToPath} from "node:url"; import {value} from "../src/value.js"; test("value", () => {
          const bundle = new URL("../bundle/main.cjs", import.meta.url);
          expect(readFileSync(bundle, "utf8")).toContain("sourceMappingURL=");
          const launcher = new URL("../bundle/launcher.cjs", import.meta.url);
          expect(readFileSync(launcher, "utf8")).toContain("sourceMappingURL=");
          expect(readFileSync(new URL("../languages/index.toml", import.meta.url), "utf8")).toBe("# inherited language definitions\\n");
          expect(readFileSync(new URL("../collections/index.toml", import.meta.url), "utf8")).toBe("# pinned collection dependencies\\n");
          expect(existsSync(new URL("../workbench/.collections", import.meta.url))).toBe(false);
          expect(readFileSync(new URL("../.pnpmfile.cjs", import.meta.url), "utf8")).toBe("// managed dependency storage\\n");
          const cli = spawnSync(process.execPath, [fileURLToPath(bundle)], {encoding: "utf8"});
          expect(cli.status).toBe(0); expect(cli.stdout.trim()).toBe("42");
          expect(value()).toBe(${outcome === "test failure" ? "0" : "42"});
          ${outcome === "invalid report" ? `writeFileSync(process.env.NODE_V8_COVERAGE + "/coverage-123-456-7.json", '{"PRIVATE SOURCE');` : ""}
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
          outcome === "test failure"
            ? /tests or coverage collection failed/
            : outcome === "invalid report"
              ? /Invalid Node coverage report/
              : /functions coverage .* below 100/,
        );
      assert.deepEqual(readdirSync(external), ["keep"]);
      if (outcome === "test failure") assert.deepEqual(readdirSync(join(root, "build")), []);
      const results = JSON.parse(readFileSync(join(root, "coverage/tests.json"), "utf8")) as {
        success: boolean;
        numTotalTests: number;
        testResults: {
          name: string;
          startTime: number;
          endTime: number;
          assertionResults: { title: string; status: string; duration: number; failureMessages: string[] }[];
        }[];
      };
      assert.equal(results.success, outcome !== "test failure");
      assert.equal(Object.hasOwn(results, "coverageMap"), false);
      assert.equal(results.numTotalTests, 1);
      const suite = required(results.testResults[0], "Test suite result");
      assert.equal(resolve(suite.name), join(root, "tests/value.test.mjs"));
      assert.ok(suite.endTime >= suite.startTime);
      const assertion = required(suite.assertionResults[0], "Assertion result");
      assert.equal(assertion.title, "value");
      assert.equal(assertion.status, outcome === "test failure" ? "failed" : "passed");
      assert.ok(assertion.duration >= 0);
      if (outcome === "test failure") assert.ok(assertion.failureMessages.length > 0);
      assert.equal(existsSync(summaryPath), true);
      if (["test failure", "invalid report"].includes(outcome))
        assert.equal(readFileSync(summaryPath, "utf8"), previousSummary);
      if (outcome === "invalid report") {
        const diagnostics = readFileSync(join(root, "coverage/collection-error.json"), "utf8");
        assert.deepEqual(JSON.parse(diagnostics), {
          file: "coverage-123-456-7.json",
          bytes: 16,
          pid: 123,
          thread: 7,
          reason: "invalid-json",
        });
        assert.ok(!diagnostics.includes("PRIVATE SOURCE"));
      }
      assert.ok(
        readdirSync(join(root, "coverage")).every((name) =>
          [
            "coverage-final.json",
            "coverage-summary.json",
            "tests.json",
            "timings.json",
            ...(outcome === "invalid report" ? ["collection-error.json"] : []),
          ].includes(name),
        ),
      );
      const timings = JSON.parse(readFileSync(join(root, "coverage/timings.json"), "utf8")) as CoverageTimings;
      assert.equal(timings.version, 1);
      assert.ok(Number.isFinite(timings.totalMs) && timings.totalMs >= 0);
      assert.ok(timings.phases.cleanup);
      assert.ok(timings.phases.tests);
      for (const phase of Object.values(timings.phases))
        assert.ok(Number.isFinite(phase.milliseconds) && phase.milliseconds >= 0);
      if (outcome === "pass") {
        assert.ok(required(timings.phases.subprocessReports?.count, "Raw report count") > 0);
        assert.ok(required(timings.phases.subprocessConversion?.count, "Converted script count") > 0);
      }
      for (const [name, contents] of shipped)
        assert.equal(readFileSync(join(root, `bundle/${name}.cjs`), "utf8"), contents);
      if (!["test failure", "invalid report"].includes(outcome)) {
        const measured = JSON.parse(readFileSync(join(root, "coverage/coverage-final.json"), "utf8")) as Record<
          string,
          { path: string }
        >;
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-coverage-merge-")));
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "workbench-coverage-copy-")));
  const { mergeCoverage } = await import("../scripts/test-coverage.mjs");
  const run = (args: readonly string[], env = {}) => {
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
      const counts = Object.entries(file.fnMap).map(([id, fn]) => [fn.name, file.f[id]] as const);
      assert.ok(
        counts.some(([fn, count]) => fn === name && required(count, "Fixture value count") > 0),
        JSON.stringify(counts),
      );
      assert.ok(
        counts.filter(([fn]) => required(fn, "Fixture value fn").startsWith("never")).every(([, count]) => count === 0),
      );
    }
    for (const name of ["changed", "unimported"])
      assert.equal(map.fileCoverageFor(join(root, `src/${name}.js`)).toSummary().functions.covered, 0);
    assert.throws(
      () =>
        mergeCoverage([join(root, "coverage/coverage-final.json")], join(root, "coverage/strict"), { functions: 100 }),
      /below 100/,
    );
    writeFileSync(join(temporary, "incomplete.json"), "");
    await assert.rejects(subprocessCoverage(temporary, root), /Invalid Node coverage report: incomplete.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test("subprocess coverage measures standalone ESM helpers and CommonJS launchers", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-helper-coverage-")));
  try {
    for (const directory of ["bundle", "scripts", "bin", "raw"]) mkdirSync(join(root, directory));
    for (const [file, header] of [
      ["scripts/helper.mjs", "export "],
      ["bin/launcher.cjs", ""],
    ] as const) {
      writeFileSync(
        join(root, required(file, "Fixture value file")),
        `${header}function choose(value) { if (value === "yes") return 42; return 0; }\n${header}function never() { return 9; }\nconsole.log(choose(process.argv[2]));\n`,
      );
      for (const argument of ["yes", "no"]) {
        const result = spawnSync(process.execPath, [join(root, required(file, "Fixture value file")), argument], {
          env: { ...process.env, NODE_V8_COVERAGE: join(root, "raw") },
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), argument === "yes" ? "42" : "0");
      }
    }
    const map = await subprocessCoverage(join(root, "raw"), root);
    for (const file of ["scripts/helper.mjs", "bin/launcher.cjs"]) {
      const measured = map.fileCoverageFor(join(root, file));
      const counts = Object.entries(measured.fnMap).map(([id, fn]) => [fn.name, measured.f[id]] as const);
      assert.ok(
        counts.some(([name, count]) => name === "choose" && required(count, "Fixture value count") > 0),
        JSON.stringify(counts),
      );
      assert.ok(
        counts.some(([name, count]) => name === "never" && count === 0),
        JSON.stringify(counts),
      );
      assert.ok(measured.toSummary().branches.covered > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subprocess coverage attributes copied TypeScript helpers to their original source", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-typescript-helper-coverage-")));
  const root = join(temporary, "project");
  const copy = join(temporary, "copied-helper.mjs");
  try {
    for (const directory of ["scripts", "raw"]) mkdirSync(join(root, directory), { recursive: true });
    const source = join(root, "scripts/helper.mts");
    const emitted = join(root, "scripts/helper.mjs");
    writeFileSync(
      source,
      'export function choose(value: string): number { if (value === "yes") return 42; return 0; }\n' +
        'export function never(): number { return 9; }\nconsole.log(choose(process.argv[2] ?? "no"));\n',
    );
    await build({
      entryPoints: [source],
      outfile: emitted,
      format: "esm",
      platform: "node",
      target: "es2022",
      sourcemap: "inline",
    });
    cpSync(emitted, copy);
    for (const argument of ["yes", "no"]) {
      const result = spawnSync(process.execPath, [copy, argument], {
        env: { ...process.env, NODE_V8_COVERAGE: join(root, "raw") },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), argument === "yes" ? "42" : "0");
    }
    rmSync(copy);
    const map = await subprocessCoverage(join(root, "raw"), root);
    assert.deepEqual(map.files(), [source]);
    const measured = map.fileCoverageFor(source);
    const counts = Object.entries(measured.fnMap).map(([id, fn]) => [fn.name, measured.f[id]] as const);
    assert.ok(
      counts.some(([name, count]) => name === "choose" && required(count, "Covered function count") > 0),
      JSON.stringify(counts),
    );
    assert.ok(
      counts.some(([name, count]) => name === "never" && count === 0),
      JSON.stringify(counts),
    );
    assert.ok(measured.toSummary().branches.covered > 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test.each([
  ["first", "second"],
  ["one/helper", "two/helper"],
])(
  "subprocess coverage retains distinct original and copied helpers with identical contents (%s, %s)",
  async (first, second) => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-identical-helper-coverage-")));
    const root = join(temporary, "project");
    try {
      for (const directory of ["scripts", "examples", "bin", "tests/fixtures", "raw"])
        mkdirSync(join(root, directory), { recursive: true });
      for (const name of ["ci-docker", "ci-workbench"])
        writeFileSync(join(root, `tests/fixtures/${name}.mts`), 'export const fixture: string = "unused";\n');
      const sources: string[] = [];
      for (const name of [first, second]) {
        const source = join(root, `scripts/${name}.mts`);
        sources.push(source);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(
          source,
          "export function used(): number { return 42; }\nexport function never(): number { return 0; }\nconsole.log(used());\n",
        );
      }
      await buildTooling(root);
      for (const [index, name] of [first, second].entries()) {
        const emitted = join(root, `scripts/${name}.mjs`);
        const copy = join(temporary, `relocated-${String(index)}.mjs`);
        cpSync(emitted, copy);
        for (const executable of [emitted, copy]) {
          const result = spawnSync(process.execPath, [executable], {
            env: { ...process.env, NODE_V8_COVERAGE: join(root, "raw") },
            encoding: "utf8",
          });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout.trim(), "42");
        }
        rmSync(copy);
      }
      const map = await subprocessCoverage(join(root, "raw"), root);
      assert.deepEqual(map.files().sort(), sources.sort());
      for (const source of sources) {
        const measured = map.fileCoverageFor(source);
        const counts = Object.entries(measured.fnMap).map(([id, fn]) => [fn.name, measured.f[id]] as const);
        assert.ok(
          counts.some(([name, count]) => name === "used" && count === 2),
          JSON.stringify(counts),
        );
        assert.ok(
          counts.some(([name, count]) => name === "never" && count === 0),
          JSON.stringify(counts),
        );
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test("subprocess coverage rejects an ambiguous copied map without a portable file identity", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-ambiguous-helper-coverage-")));
  const root = join(temporary, "project");
  const raw = join(root, "raw");
  const copiedRaw = join(root, "copied-raw");
  const copy = join(temporary, "relocated.mjs");
  try {
    const sources: string[] = [];
    for (const directory of ["one", "two"]) {
      const source = join(root, `scripts/${directory}/helper.mts`);
      const emitted = join(root, `scripts/${directory}/helper.mjs`);
      sources.push(source);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, "export function used(): number { return 42; }\nconsole.log(used());\n");
      await build({ entryPoints: [source], outfile: emitted, format: "esm", sourcemap: "inline" });
      const result = spawnSync(process.execPath, [emitted], {
        env: { ...process.env, NODE_V8_COVERAGE: raw },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      if (directory === "one") cpSync(emitted, copy);
    }
    assert.deepEqual((await subprocessCoverage(raw, root)).files().sort(), sources.sort());
    const copied = spawnSync(process.execPath, [copy], {
      env: { ...process.env, NODE_V8_COVERAGE: copiedRaw },
      encoding: "utf8",
    });
    assert.equal(copied.status, 0, copied.stderr);
    rmSync(copy);
    await assert.rejects(subprocessCoverage(copiedRaw, root), /copied coverage source is ambiguous/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("subprocess coverage preserves execution counts and block precedence across merge batches", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-batched-coverage-")));
  try {
    const raw = join(root, "raw");
    const repeated = join(root, "repeated");
    const helper = join(root, "scripts/helper.mjs");
    mkdirSync(dirname(helper));
    mkdirSync(repeated);
    writeFileSync(
      helper,
      'export function choose(value) { if (value === "yes") return 42; return 0; }\n' +
        "export function never() { return 9; }\nconsole.log(choose(process.argv[2]));\n",
    );
    for (const argument of ["yes", "no"]) {
      const result = spawnSync(process.execPath, [helper, argument], {
        env: { ...process.env, NODE_V8_COVERAGE: raw },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const reference = (await subprocessCoverage(raw, root)).fileCoverageFor(helper);
    const reports = readdirSync(raw).map((name) => readFileSync(join(raw, name), "utf8"));
    assert.equal(reports.length, 2);
    for (let index = 0; index < 70; index++)
      writeFileSync(join(repeated, `${String(index).padStart(3, "0")}.json`), required(reports[index % 2], "Report"));
    const functionOnly = JSON.parse(required(reports[0], "Report")) as NodeCoverageReport;
    for (const script of functionOnly.result) {
      if (!script.url.endsWith("/scripts/helper.mjs")) continue;
      script.functions = script.functions.filter((fn) => fn.functionName === "choose");
      for (const fn of script.functions) {
        fn.isBlockCoverage = false;
        fn.ranges = [{ ...required(fn.ranges[0], "Function range"), count: 999 }];
      }
    }
    // Function-only counts must lose to block coverage both before and after a batch is merged.
    for (const name of ["000-before", "999-after"])
      writeFileSync(join(repeated, `${name}.json`), JSON.stringify(functionOnly));
    const measured = (await subprocessCoverage(repeated, root)).fileCoverageFor(helper);
    assert.deepEqual(measured.statementMap, reference.statementMap);
    assert.deepEqual(measured.fnMap, reference.fnMap);
    assert.deepEqual(measured.branchMap, reference.branchMap);
    assert.deepEqual(
      measured.s,
      Object.fromEntries(Object.entries(reference.s).map(([id, count]) => [id, count * 35])),
    );
    assert.deepEqual(
      measured.f,
      Object.fromEntries(Object.entries(reference.f).map(([id, count]) => [id, count * 35])),
    );
    assert.deepEqual(
      measured.b,
      Object.fromEntries(Object.entries(reference.b).map(([id, counts]) => [id, counts.map((count) => count * 35)])),
    );
    const choose = Object.entries(measured.fnMap).find(([, fn]) => fn.name === "choose");
    assert.equal(measured.f[required(choose, "Measured function")[0]], 70);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["mappings", "names", "sourcesContent"] as const)(
  "subprocess coverage checks %s again when a report reuses a source-map identity",
  async (field) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-map-identity-")));
    try {
      const source = join(root, "scripts/helper.mts");
      const emitted = join(root, "scripts/helper.mjs");
      const raw = join(root, "raw");
      mkdirSync(dirname(source));
      writeFileSync(source, "export function used(): number { return 42; }\nconsole.log(used());\n");
      await build({ entryPoints: [source], outfile: emitted, format: "esm", sourcemap: "inline" });
      const executed = spawnSync(process.execPath, [emitted], {
        env: { ...process.env, NODE_V8_COVERAGE: raw },
        encoding: "utf8",
      });
      assert.equal(executed.status, 0, executed.stderr);
      const reference = await subprocessCoverage(raw, root);
      const report = JSON.parse(
        readFileSync(join(raw, required(readdirSync(raw)[0], "Raw report")), "utf8"),
      ) as NodeCoverageReport;
      const sourceMap = required(Object.values(required(report["source-map-cache"], "Source maps"))[0]?.data, "Map");
      if (field === "mappings") sourceMap.mappings += "A";
      else if (field === "names") sourceMap.names = [...sourceMap.names, "different"];
      else sourceMap.sourcesContent = ["export function used(): number { return 99; }\nconsole.log(used());\n"];
      writeFileSync(join(raw, "reused-identity.json"), JSON.stringify(report));
      assert.deepEqual((await subprocessCoverage(raw, root)).toJSON(), reference.toJSON());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
