import { afterEach, expect, test } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  compileBundles,
  publishBundles,
  verifyBundles,
  bundleEntries,
  type BundleSet,
} from "../scripts/bundle-build.mts";
import { verifyRuntimeDependencies } from "../scripts/runtime-dependencies.mts";
import { toolingArtifact } from "../scripts/tooling-artifacts.mts";

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
    join(root, "scripts/runtime.mjs"),
    'import "./bridge.mjs"; new Worker(new URL("worker.mjs?version=1#start", import.meta.url));\n',
  );
  writeFileSync(join(root, "scripts/bridge.mjs"), 'import "./test-coverage.mjs";\n');
  writeFileSync(join(root, "scripts/test-coverage.mjs"), "export {};\n");
  const request = {
    root,
    artifacts: [toolingArtifact("scripts/runtime.mts")],
    outputs: [{ path: "bundle/main.cjs", contents: Buffer.from("module.exports={};") }],
    scripts: [],
    references: [{ origin: "bundle/main.cjs", path: "bundle/main.cjs.br" }],
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/scripts\/test-coverage.mjs/);
  writeFileSync(join(root, "scripts/bridge.mjs"), "export {};\n");
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/scripts\/worker.mjs/);
  writeFileSync(join(root, "scripts/worker.mjs"), 'import "node:fs"; export {};\n');
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/bundle\/main.cjs.br/);
  request.outputs.push({ path: "bundle/main.cjs.br", contents: Buffer.from("opaque payload") });
  expect(() => {
    verifyRuntimeDependencies(request);
  }).not.toThrow();
  writeFileSync(
    join(root, "scripts/runtime.mjs"),
    `new URL(${JSON.stringify(pathToFileURL(join(root, "scripts/worker.mjs")).href)}, import.meta.url);\n`,
  );
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/absolute path/);
});

test("shipped language templates cannot name omitted runtime assets", () => {
  const root = fixture();
  mkdirSync(join(root, "languages/example"), { recursive: true });
  writeFileSync(join(root, "languages/example/automation.toml"), 'command=["node","{workbench}/scripts/absent.mjs"]\n');
  const request = {
    root,
    artifacts: [],
    outputs: [{ path: "bundle/main.cjs", contents: Buffer.from("module.exports={};") }],
    scripts: [],
    references: [],
  };
  expect(() => {
    verifyRuntimeDependencies(request);
  }).toThrow(/languages.*automation.toml.*scripts\/absent.mjs/);
  writeFileSync(join(root, "scripts/absent.mjs"), "export {};\n");
  expect(() => {
    verifyRuntimeDependencies(request);
  }).not.toThrow();
});
