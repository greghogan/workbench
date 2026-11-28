import { bundleSource, lazyBundles } from "../../../src/core/distribution/bundle-artifacts.mts";
import {
  bundleInputDigest,
  reuseBundles,
  bundleCacheFile,
  developmentToolingReceipt,
} from "../../../../scripts/bundle-cache.mts";
import { buildTooling } from "../../../../scripts/build-tooling.mts";
import { afterEach, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compileBundles,
  publishBundles,
  verifyBundles,
  bundleEntries,
  type BundleSet,
} from "../../../../scripts/bundle-build.mts";
import { verifyRuntimeDependencies } from "../../../../scripts/runtime-dependencies.mts";
import { toolingArtifact } from "../../../src/core/distribution/tooling-artifacts.mts";
import { build } from "esbuild";
import { bundleOptions } from "../../../../scripts/bundle-options.mts";
import { coverageWorkspace } from "../../../../scripts/test-coverage.mts";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { diagnosticError } from "../../../src/core/diagnostics/diagnostic-errors.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-build-pipeline-"));
  temporary.push(root);
  for (const path of ["app/src/core/runtime", "workbench", "bin", "scripts", "bundle"])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "workbench/config.toml"), '[licenses]\nallow=["MIT"]\n');
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      files: ["bin", "bundle", "scripts", "app/src", "languages"],
      bin: { workbench: "bin/workbench.mjs" },
    }),
  );
  writeFileSync(join(root, "bin/workbench.mjs"), 'import "../bundle/main.cjs";\n');
  cpSync(new URL("../../../../bin/bundle-runtime.cjs", import.meta.url), join(root, "bin/bundle-runtime.cjs"));
  for (const name of bundleEntries) {
    const entry = join(root, bundleSource(name));
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "export const value: number = 42;\n");
  }
  return root;
}

test("development setup reuses intact helpers and repairs damaged output", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-development-tooling-"));
  temporary.push(root);
  mkdirSync(join(root, "scripts"));
  const authored = join(root, "scripts/fixture.mts");
  const emitted = join(root, "scripts/fixture.mjs");
  const receipt = join(root, developmentToolingReceipt);
  const prepare = () => buildTooling({ root, operation: "prepare-development" });
  writeFileSync(authored, "export const value: number = 42;\n");
  await prepare();
  const expected = readFileSync(emitted, "utf8");
  utimesSync(receipt, new Date(0), new Date(0));
  await prepare();
  expect(statSync(receipt).mtimeMs).toBe(0);
  writeFileSync(emitted, "damaged output\n");
  await prepare();
  expect(readFileSync(emitted, "utf8")).toBe(expected);
  writeFileSync(authored, "export const value: number = 84;\n");
  await prepare();
  expect(readFileSync(emitted, "utf8")).toContain("value = 84");
});

test("bundle candidates are read-only, ordered for publication, executable, and verified by the same construction", async () => {
  const root = fixture();
  writeFileSync(join(root, "bundle/formatter.cjs"), "old loader");
  writeFileSync(join(root, "bundle/formatter.cjs.br"), "old payload");
  writeFileSync(join(root, "bundle/formatter.cjs.gz"), "old format");
  const candidates = await compileBundles(root);
  expect(readFileSync(join(root, "bundle/formatter.cjs"), "utf8")).toBe("old loader");
  const firstLoader = candidates.outputs.findIndex((output) => output.kind === "loader");
  expect(candidates.outputs.every((output, index) => output.kind !== "payload" || index < firstLoader)).toBe(true);
  publishBundles(root, candidates);
  expect(existsSync(join(root, "bundle/formatter.cjs.gz"))).toBe(false);
  expect(existsSync(join(root, "bundle/formatter.cjs.br"))).toBe(true);
  verifyBundles(root, candidates);
  const result = spawnSync(process.execPath, ["-e", 'console.log(require("./bundle/main.cjs").value)'], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("42");
  writeFileSync(join(root, "bundle/main.cjs"), "corrupt");
  expect(() => {
    verifyBundles(root, candidates);
  }).toThrow(/bundle\/main.cjs is stale/);
});

test("source snapshots reuse intact bundles only for matching canonical build inputs", async () => {
  const root = fixture(),
    target = fixture();
  for (const directory of [root, target])
    writeFileSync(join(directory, "scripts/generated.mts"), "export const value = 42;\n");
  const set = await compileBundles(root);
  publishBundles(root, set);
  expect(reuseBundles(root, target)).toBe(true);
  verifyBundles(target, set);
  const generated = join(target, "scripts/generated.mjs");
  symlinkSync(join(root, bundleSource("main")), generated, "file");
  expect(reuseBundles(root, target)).toBe(true);
  writeFileSync(join(target, "workbench/notes.md"), "Unrelated record content\n");
  expect(reuseBundles(root, target)).toBe(true);
  writeFileSync(join(target, "app/test/only.test.mts"), "export const testFixture = true;\n");
  expect(reuseBundles(root, target)).toBe(true);
  const consumer = join(target, bundleSource("consumer"));
  const originalConsumer = readFileSync(consumer, "utf8");
  writeFileSync(consumer, "export const changedConsumer = true;\n");
  expect(reuseBundles(root, target)).toBe(false);
  writeFileSync(consumer, originalConsumer);
  const source = join(target, bundleSource("main"));
  writeFileSync(source, "export const value: number = 43;\n");
  expect(reuseBundles(root, target)).toBe(false);
  writeFileSync(source, "export const value: number = 42;\n");
  writeFileSync(join(target, "scripts/new-builder.mts"), "export const changed = true;\n");
  expect(reuseBundles(root, target)).toBe(false);
  rmSync(join(target, "scripts/new-builder.mts"));
  writeFileSync(join(target, "pnpm-lock.yaml"), "changed dependency pins\n");
  expect(reuseBundles(root, target)).toBe(false);
  rmSync(join(target, "pnpm-lock.yaml"));
  expect(reuseBundles(root, target)).toBe(true);
  writeFileSync(join(root, bundleSource("main")), "export const value: number = 99;\n");
  expect(reuseBundles(root)).toBe(false);
  expect(reuseBundles(root, target)).toBe(true);
  verifyBundles(target, set);
});

test("bundle caching rejects symbolic-link inputs instead of overlooking changes to their targets", async () => {
  const root = fixture(),
    linked = fixture();
  const source = join(root, bundleSource("main"));
  rmSync(source);
  symlinkSync(join(linked, bundleSource("main")), source, "file");
  await expect(compileBundles(root)).rejects.toThrow(/symbolic-link bundle inputs/);
  expect(existsSync(join(root, bundleCacheFile))).toBe(false);
});

test("missing, incomplete, malformed, and damaged bundle caches are rebuilt without copying partial outputs", async () => {
  const root = fixture(),
    target = fixture();
  expect(reuseBundles(root, target)).toBe(false);
  const set = await compileBundles(root);
  publishBundles(root, set);
  const receipt = readFileSync(join(root, bundleCacheFile));
  writeFileSync(join(root, bundleCacheFile), "{truncated");
  expect(reuseBundles(root, target)).toBe(false);
  writeFileSync(join(root, bundleCacheFile), receipt);
  writeFileSync(join(root, "bundle/main.cjs"), "damaged output");
  expect(reuseBundles(root, target)).toBe(false);
  expect(existsSync(join(target, "bundle/main.cjs"))).toBe(false);
  publishBundles(root, set);
  const payload = set.outputs.find((file) => file.kind === "payload");
  expect(payload).toBeDefined();
  if (!payload) throw new Error("Missing fixture payload");
  rmSync(join(root, payload.path));
  expect(reuseBundles(root, target)).toBe(false);
  expect(existsSync(join(target, "bundle/main.cjs"))).toBe(false);
  publishBundles(root, set);
  const changed = readFileSync(join(root, bundleSource("main")), "utf8");
  writeFileSync(join(root, bundleSource("main")), changed + "export const changed = true;\n");
  expect(() => {
    publishBundles(root, set);
  }).toThrow(/Source changed/);
});

test("the native main bundle loads without custom VM evaluation or a compressed payload", async () => {
  const root = fixture();
  const candidates = await compileBundles(root);
  publishBundles(root, candidates);
  expect(existsSync(join(root, "bundle/main.cjs.br"))).toBe(false);
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'require("node:vm").compileFunction=()=>{throw Error("custom loader used")}; console.log(require("./bundle/main.cjs").value)',
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("42");
});

test.each([false, true])(
  "lazy compressed bundles preserve loading and missing-file errors through an alias: %s",
  async (alias) => {
    let root = fixture();
    if (alias) {
      const linked = root + "-alias";
      symlinkSync(root, linked, "junction");
      temporary.push(linked);
      root = linked;
    }
    writeFileSync(
      join(root, bundleSource("main")),
      lazyBundles
        .map((name, index) => {
          const path = relative(dirname(bundleSource("main")), bundleSource(name))
            .replaceAll("\\", "/")
            .replace(/\.ts$/, ".js");
          return `export async function load${String(index)}() { return (await import(${JSON.stringify(path)})).value; }`;
        })
        .join("\n"),
    );
    const bundles = await compileBundles(root);
    publishBundles(root, bundles);
    const run = (code: string) => spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8" });
    for (const [index, name] of lazyBundles.entries()) {
      const normal = run(
        `const path=require.resolve("./bundle/${name}.cjs"); require("./bundle/main.cjs"); if(require.cache[path]) throw Error("Module loaded eagerly");`,
      );
      expect(normal.status, normal.stderr).toBe(0);
      const loaded = run(`require("./bundle/main.cjs").load${String(index)}().then(console.log);`);
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout.trim()).toBe("42");
      rmSync(join(root, `bundle/${name}.cjs.br`));
      expect(run('require("./bundle/main.cjs");').status).toBe(0);
      const missing = run(
        `require("./bundle/main.cjs").load${String(index)}().catch(error=>{console.error(error.message);process.exitCode=1});`,
      );
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`${name}.cjs.br`);
    }
  },
);

test("bundle verification rejects a dependency beyond that bundle's declared Node support", async () => {
  const root = fixture();
  mkdirSync(join(root, "node_modules/modern"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/modern/package.json"),
    JSON.stringify({ name: "modern", version: "1.0.0", license: "MIT", engines: { node: ">=22" } }),
  );
  writeFileSync(join(root, "node_modules/modern/index.js"), "exports.value = 42;\n");
  writeFileSync(join(root, "app/src/core/distribution/bootstrap.ts"), 'export { value } from "modern";\n');
  await expect(compileBundles(root)).rejects.toThrow(/bootstrap: modern@1.0.0 requires Node >=22.*18.20.8/);
});

test("bundle verification accepts alternate compression of identical JavaScript and rejects changed code", async () => {
  const root = fixture();
  const candidates = await compileBundles(root);
  publishBundles(root, candidates);
  const path = join(root, "bundle/formatter.cjs.br");
  const original = readFileSync(path);
  const code = brotliDecompressSync(original);
  const alternate = brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 0 } });
  expect(alternate.equals(original)).toBe(false);
  writeFileSync(path, alternate);
  expect(() => {
    verifyBundles(root, candidates);
  }).not.toThrow();
  const executed = spawnSync(process.execPath, ["-e", 'console.log(require("./bundle/formatter.cjs").value)'], {
    cwd: root,
    encoding: "utf8",
  });
  expect(executed.status, executed.stderr).toBe(0);
  expect(executed.stdout.trim()).toBe("42");
  const changed = Buffer.from(code.toString().replace("42", "43"));
  expect(changed.equals(code)).toBe(false);
  writeFileSync(path, brotliCompressSync(changed));
  expect(() => {
    verifyBundles(root, candidates);
  }).toThrow(/formatter.cjs.br is stale/);
  expect(readFileSync(join(root, "coverage/bundle-parity/formatter.cjs.br.expected.cjs"))).toEqual(code);
  expect(readFileSync(join(root, "coverage/bundle-parity/formatter.cjs.br.committed.cjs"))).toEqual(changed);
});

test("bundle parity retains exact loader and license-notice verification", async () => {
  const root = fixture();
  const candidates = await compileBundles(root);
  publishBundles(root, candidates);
  for (const relative of ["bundle/main.cjs", "bundle/THIRD_PARTY_NOTICES.txt"]) {
    const path = join(root, relative);
    const contents = readFileSync(path);
    writeFileSync(path, Buffer.concat([contents, Buffer.from("\n")]));
    expect(() => {
      verifyBundles(root, candidates);
    }).toThrow(`${relative} is stale`);
    writeFileSync(path, contents);
  }
});

test("bundle mismatch diagnostics preserve the code error and do not follow output-directory links", async () => {
  const root = fixture();
  const candidates = await compileBundles(root);
  publishBundles(root, candidates);
  const path = join(root, "bundle/formatter.cjs.br");
  const code = brotliDecompressSync(readFileSync(path)).toString();
  writeFileSync(path, brotliCompressSync(code.replace("42", "43")));
  const kept = join(root, "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "unrelated"), "preserve");
  symlinkSync(kept, join(root, "coverage"), "junction");
  let failure: unknown;
  try {
    verifyBundles(root, candidates);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const diagnostic = JSON.stringify(diagnosticError(failure));
  expect(diagnostic).toContain("JavaScript differs");
  expect(diagnostic).toContain("must be a real directory");
  expect(readdirSync(kept)).toEqual(["unrelated"]);
  expect(readFileSync(join(kept, "unrelated"), "utf8")).toBe("preserve");
});

test("a staging failure leaves active bundles untouched and removes already staged candidates", () => {
  const root = fixture();
  writeFileSync(join(root, "bundle/main.cjs"), "active loader");
  writeFileSync(join(root, "blocked"), "file instead of directory");
  const set: BundleSet = {
    inputs: bundleInputDigest(root),
    obsolete: [],
    scripts: [],
    references: [],
    outputs: [
      { path: "bundle/main.cjs", contents: Buffer.from("replacement"), kind: "loader" },
      { path: "blocked/payload", contents: Buffer.from("payload"), kind: "payload", compression: "brotli" },
    ],
  };
  expect(() => {
    publishBundles(root, set);
  }).toThrow();
  expect(readFileSync(join(root, "bundle/main.cjs"), "utf8")).toBe("active loader");
  expect(readdirSync(join(root, "bundle"))).toEqual(["main.cjs"]);
});

test("runtime dependency verification follows imports, worker URLs and declared payload references", () => {
  const root = fixture();
  writeFileSync(
    join(root, "scripts/clean.mjs"),
    'import "../app/src/core/runtime/owned-child.mjs"; new Worker(new URL("../app/src/core/runtime/process-outcome.mjs?version=1#start", import.meta.url));\n',
  );
  writeFileSync(
    join(root, "app/src/core/runtime/owned-child.mjs"),
    'import "../../../../scripts/test-coverage.mjs";\n',
  );
  writeFileSync(join(root, "scripts/test-coverage.mjs"), "export {};\n");
  const request = {
    root,
    artifacts: [toolingArtifact("scripts/clean.mts")],
    outputs: [{ path: "bundle/main.cjs", contents: Buffer.from("module.exports={};") }],
    scripts: [],
    references: [{ origin: "bundle/main.cjs", path: "bundle/formatter.cjs.br" }],
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/scripts\/test-coverage.mjs/);
  writeFileSync(join(root, "app/src/core/runtime/owned-child.mjs"), "export {};\n");
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/core\/runtime\/process-outcome.mjs/);
  writeFileSync(join(root, "app/src/core/runtime/process-outcome.mjs"), 'import "node:fs"; export {};\n');
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/bundle\/formatter.cjs.br/);
  request.outputs.push({ path: "bundle/formatter.cjs.br", contents: Buffer.from("opaque payload") });
  expect(() => {
    verifyRuntimeDependencies(request);
  }).not.toThrow();
  writeFileSync(join(root, "scripts/clean.mjs"), 'import "./script-entry.mts";\n');
  writeFileSync(join(root, "scripts/script-entry.mts"), "export {};\n");
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/runtime imports require generated JavaScript/);
  writeFileSync(
    join(root, "scripts/clean.mjs"),
    `new URL(${JSON.stringify(pathToFileURL(join(root, "app/src/core/runtime/process-outcome.mjs")).href)}, import.meta.url);\n`,
  );
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/absolute path/);
});

test("shipped language templates cannot name omitted runtime assets", () => {
  const root = fixture();
  mkdirSync(join(root, "languages/example"), { recursive: true });
  writeFileSync(
    join(root, "languages/example/automation.toml"),
    'command=["node","{workbench}/scripts/native-coverage.mjs"]\n',
  );
  const request = {
    root,
    artifacts: [],
    outputs: [{ path: "bundle/main.cjs", contents: Buffer.from("module.exports={};") }],
    scripts: [],
    references: [],
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/languages.*automation.toml.*scripts\/native-coverage.mjs/);
  writeFileSync(join(root, "scripts/native-coverage.mjs"), "export {};\n");
  expect(() => {
    verifyRuntimeDependencies(request);
  }).not.toThrow();
});

test("runtime imports require builtins or declared runtime packages, including scoped package subpaths", () => {
  const root = fixture();
  const manifest = join(root, "package.json");
  const metadata = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  metadata.devDependencies = { "build-only": "1.0.0" };
  metadata.dependencies = { "@runtime/library": "1.0.0" };
  writeFileSync(manifest, JSON.stringify(metadata));
  const request = {
    root,
    artifacts: [],
    outputs: [{ path: "bundle/main.cjs", contents: Buffer.from('require("build-only");') }],
    scripts: [],
    references: [],
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/runtime package is not declared: build-only/);
  request.outputs[0] = {
    path: "bundle/main.cjs",
    contents: Buffer.from('require("fs"); require("node:fs"); require("@runtime/library/feature");'),
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).not.toThrow();
});

test("coverage builds use authored helpers even when emitted ESM would be invalid in CommonJS", async () => {
  const root = fixture();
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "scripts/value.mts"), "export const value: number = 42;\n");
  writeFileSync(
    join(root, "scripts/value.mjs"),
    'import { createRequire } from "node:module"; createRequire(import.meta.url); export const value = 0;\n',
  );
  writeFileSync(join(root, "app/src/cli/main.ts"), 'export { value } from "../../../scripts/value.mjs";\n');
  const capture = join(root, "capture");
  mkdirSync(capture);
  const workspace = await coverageWorkspace(root, capture);
  const result = spawnSync(process.execPath, ["-e", 'console.log(require("./bundle/main.cjs").value)'], {
    cwd: workspace.root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("42");
});

test("the Node 18 bootstrap artifact excludes the modern terminal rendering dependencies", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const result = await build({ ...bundleOptions(root, "bootstrap"), write: false });
  const emitted = Object.values(result.metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path),
  );
  expect(emitted.filter((path) => /node_modules[\\/]string-width[\\/]/.test(path))).toEqual([]);
});

test("CLI configuration and lazy server actions share the same core service state", async () => {
  const root = fixture();
  mkdirSync(join(root, "app/src/server"), { recursive: true });
  writeFileSync(
    join(root, "app/src/core/shared.ts"),
    'let policy = "default"; export const configure = (value: string) => { policy = value; }; export const read = () => policy;\n',
  );
  writeFileSync(join(root, "app/src/server/runtime.ts"), 'export { read } from "../core/shared.js";\n');
  writeFileSync(
    join(root, bundleSource("main")),
    'export { configure } from "../core/shared.js"; export async function serverPolicy() { return (await import("../server/runtime.js")).read(); }\n',
  );
  publishBundles(root, await compileBundles(root));
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'const cli = require("./bundle/main.cjs"); cli.configure("configured"); cli.serverPolicy().then(console.log);',
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("configured");
});
