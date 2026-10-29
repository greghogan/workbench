import { afterEach, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compileBundles,
  publishBundles,
  verifyBundles,
  bundleEntries,
  type BundleSet,
} from "../scripts/bundle-build.mts";
import { verifyRuntimeDependencies } from "../scripts/runtime-dependencies.mts";
import { toolingArtifact } from "../scripts/tooling-artifacts.mts";
import { build } from "esbuild";
import { bundleOptions } from "../scripts/bundle-options.mts";
import { coverageWorkspace } from "../scripts/test-coverage.mts";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { diagnosticError } from "../scripts/diagnostic-errors.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-build-pipeline-"));
  temporary.push(root);
  for (const path of ["src", "workbench", "bin", "scripts", "bundle"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "workbench/config.toml"), '[licenses]\nallow=["MIT"]\n');
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ files: ["bin", "bundle", "scripts", "languages"], bin: { workbench: "bin/workbench.mjs" } }),
  );
  writeFileSync(join(root, "bin/workbench.mjs"), 'import "../bundle/main.cjs";\n');
  cpSync(new URL("../bin/bundle-runtime.cjs", import.meta.url), join(root, "bin/bundle-runtime.cjs"));
  for (const name of bundleEntries) writeFileSync(join(root, `src/${name}.ts`), "export const value: number = 42;\n");
  return root;
}

test("bundle candidates are read-only, ordered for publication, executable, and verified by the same construction", async () => {
  const root = fixture();
  writeFileSync(join(root, "bundle/main.cjs"), "old loader");
  writeFileSync(join(root, "bundle/main.cjs.gz"), "old format");
  const candidates = await compileBundles(root);
  expect(readFileSync(join(root, "bundle/main.cjs"), "utf8")).toBe("old loader");
  const firstLoader = candidates.outputs.findIndex((output) => output.kind === "loader");
  expect(candidates.outputs.every((output, index) => output.kind !== "payload" || index < firstLoader)).toBe(true);
  publishBundles(root, candidates);
  expect(existsSync(join(root, "bundle/main.cjs.gz"))).toBe(false);
  verifyBundles(root, candidates);
  const result = spawnSync(process.execPath, ["-e", 'console.log(require("./bundle/main.cjs").value)'], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("42");
  writeFileSync(join(root, "bundle/main.cjs.br"), "corrupt");
  expect(() => {
    verifyBundles(root, candidates);
  }).toThrow(/bundle\/main.cjs.br is stale/);
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
      join(root, "src/main.ts"),
      'export async function formatted() { return (await import("./formatter.js")).value; }\n',
    );
    const bundles = await compileBundles(root);
    publishBundles(root, bundles);
    const run = (code: string) => spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8" });
    const normal = run(
      'const path=require.resolve("./bundle/formatter.cjs"); require("./bundle/main.cjs"); if(require.cache[path]) throw Error("Formatter loaded eagerly");',
    );
    expect(normal.status, normal.stderr).toBe(0);
    const formatted = run('require("./bundle/main.cjs").formatted().then(console.log);');
    expect(formatted.status, formatted.stderr).toBe(0);
    expect(formatted.stdout.trim()).toBe("42");
    rmSync(join(root, "bundle/formatter.cjs.br"));
    expect(run('require("./bundle/main.cjs");').status).toBe(0);
    const missing = run(
      'require("./bundle/main.cjs").formatted().catch(error=>{console.error(error.message);process.exitCode=1});',
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/formatter.cjs.br/);
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
  writeFileSync(join(root, "src/bootstrap.ts"), 'export { value } from "modern";\n');
  await expect(compileBundles(root)).rejects.toThrow(/bootstrap: modern@1.0.0 requires Node >=22.*18.20.8/);
});

test("bundle verification accepts alternate compression of identical JavaScript and rejects changed code", async () => {
  const root = fixture();
  const candidates = await compileBundles(root);
  publishBundles(root, candidates);
  const path = join(root, "bundle/main.cjs.br");
  const original = readFileSync(path);
  const code = brotliDecompressSync(original);
  const alternate = brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 0 } });
  expect(alternate.equals(original)).toBe(false);
  writeFileSync(path, alternate);
  expect(() => {
    verifyBundles(root, candidates);
  }).not.toThrow();
  const executed = spawnSync(process.execPath, ["-e", 'console.log(require("./bundle/main.cjs").value)'], {
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
  }).toThrow(/main.cjs.br is stale/);
  expect(readFileSync(join(root, "coverage/bundle-parity/main.cjs.br.expected.cjs"))).toEqual(code);
  expect(readFileSync(join(root, "coverage/bundle-parity/main.cjs.br.committed.cjs"))).toEqual(changed);
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
  const path = join(root, "bundle/main.cjs.br");
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
    obsolete: [],
    scripts: [],
    references: [],
    outputs: [
      { path: "bundle/main.cjs", contents: Buffer.from("replacement"), kind: "loader" },
      { path: "blocked/payload", contents: Buffer.from("payload"), kind: "payload" },
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
    'import "./owned-child.mjs"; new Worker(new URL("process-outcome.mjs?version=1#start", import.meta.url));\n',
  );
  writeFileSync(join(root, "scripts/owned-child.mjs"), 'import "./test-coverage.mjs";\n');
  writeFileSync(join(root, "scripts/test-coverage.mjs"), "export {};\n");
  const request = {
    root,
    artifacts: [toolingArtifact("scripts/clean.mts")],
    outputs: [{ path: "bundle/main.cjs", contents: Buffer.from("module.exports={};") }],
    scripts: [],
    references: [{ origin: "bundle/main.cjs", path: "bundle/main.cjs.br" }],
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/scripts\/test-coverage.mjs/);
  writeFileSync(join(root, "scripts/owned-child.mjs"), "export {};\n");
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/scripts\/process-outcome.mjs/);
  writeFileSync(join(root, "scripts/process-outcome.mjs"), 'import "node:fs"; export {};\n');
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/bundle\/main.cjs.br/);
  request.outputs.push({ path: "bundle/main.cjs.br", contents: Buffer.from("opaque payload") });
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
    `new URL(${JSON.stringify(pathToFileURL(join(root, "scripts/process-outcome.mjs")).href)}, import.meta.url);\n`,
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
  writeFileSync(join(root, "src/main.ts"), 'export { value } from "../scripts/value.mjs";\n');
  const capture = join(root, "capture");
  mkdirSync(capture);
  const workspace = await coverageWorkspace(root, capture);
  const result = spawnSync(process.execPath, ["-e", 'console.log(require("./bundle/main.cjs").value)'], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("42");
});

test("the Node 18 bootstrap artifact excludes the modern terminal rendering dependencies", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = await build({ ...bundleOptions(root, "bootstrap"), write: false });
  const emitted = Object.values(result.metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path),
  );
  expect(emitted.filter((path) => /node_modules[\\/]string-width[\\/]/.test(path))).toEqual([]);
});
