import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { withManagedProcesses } from "./managed-process.mjs";
import { isRecord } from "./values.mjs";
import { nativeCheckEnvironment } from "../src/check-environment.ts";
import { buildPaths, prepareBuild } from "../src/builds.ts";
import { pruneRustCache, inspectRustCache, RustArtifactKind } from "../src/rust-cache.ts";
import { selectedToolRequirements } from "../src/tool-references.ts";
import { withToolCacheUseAsync } from "../src/tool-cache-lock.ts";
import { settleCleanup } from "../src/diagnostics.ts";

/** Actual Cargo output qualifies both artifact selection and reuse after cleanup; all Rust source is disposable test data. */
async function main(): Promise<void> {
  const distribution = resolve(import.meta.dirname, "..");
  const examplePath = "examples/languages/rust";
  const example = join(distribution, examplePath);
  const env = nativeCheckEnvironment(distribution, example);
  const tools = selectedToolRequirements(distribution, examplePath);
  const report = join(distribution, "build/consumer-integration", "rust-cache-" + randomUUID());
  mkdirSync(report, { recursive: true });
  // A complete pinned installation must be reusable without querying a release server.
  await withManagedProcesses(async (scope) => {
    const output = await scope.run(
      process.execPath,
      [join(distribution, "bin/workbench.mjs"), "tools", "install", "--path", examplePath, "--tool", "rust"],
      { cwd: distribution, env: { ...env, RUSTUP_DIST_SERVER: "http://127.0.0.1:1" }, capture: true },
    );
    writeFileSync(join(report, "tool-install.log"), output);
  });
  await withToolCacheUseAsync(async () => {
    const temporary = mkdtempSync(join(tmpdir(), "workbench-real-rust-cache-"));
    const evidence: {
      passed: boolean;
      removed?: { id: string; kind: string; bytes: number }[];
      recentArtifactsReused?: boolean;
    } = { passed: false };
    let failure: unknown;
    try {
      for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
        process.env[`WORKBENCH_${kind}_HOME`] = join(temporary, kind.toLowerCase());
      process.env.WORKBENCH_STORAGE_EXTERNAL = "true";
      process.env.WORKBENCH_STORAGE_ROOT = join(temporary, "cache");
      process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
      delete process.env.WORKBENCH_LOCAL_CONFIG_ROOT;
      delete process.env.WORKBENCH_CONTAINER_CHECKOUT;
      delete process.env.WORKBENCH_EPHEMERAL_CHECKOUT;
      const root = join(temporary, "project");
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "workbench"));
      writeFileSync(
        join(root, "workbench/config.toml"),
        "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
      );
      writeFileSync(
        join(root, "workbench/projects.toml"),
        '[[project]]\nid="fixture"\npath="."\n[[language_root]]\nlanguage="rust"\npath="."\n',
      );
      writeFileSync(join(root, "rust-toolchain.toml"), readFileSync(join(example, "rust-toolchain.toml")));
      writeFileSync(
        join(root, "Cargo.toml"),
        '[package]\nname="rust-cache-fixture"\nversion="0.1.0"\nedition="2021"\n[features]\nalternate=[]\n',
      );
      writeFileSync(
        join(root, "src/lib.rs"),
        "pub fn answer() -> u32 { 42 }\n#[test] fn preserves_behavior() { assert_eq!(answer(), 42); }\n",
      );
      await withManagedProcesses(async (scope) => {
        await scope.run("cargo", ["generate-lockfile", "--offline"], { cwd: root, env });
        const paths = buildPaths(root, root, "native", {}, false);
        prepareBuild(paths);
        const directory = join(paths.directory, "cargo");
        const cargoEnv = { ...env, CARGO_TARGET_DIR: directory, CARGO_INCREMENTAL: "1" };
        const cargo = async (args: string[]) => {
          const output = await scope.run("cargo", args, { cwd: root, env: cargoEnv, capture: true });
          writeFileSync(join(report, "cargo.log"), output, { flag: "a" });
          return output
            .split(/\r?\n/)
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line) as unknown);
        };
        await cargo(["build", "--offline", "--locked", "--message-format=json"]);
        const first = await inspectRustCache(directory, { maxAgeDays: 0, maxBytes: 0 });
        assert(
          first.groups.some((group) => group.kind === RustArtifactKind.Build),
          "Actual Cargo fingerprints were not recognized",
        );
        assert(
          first.groups.some((group) => group.kind === RustArtifactKind.Incremental),
          "Actual incremental sessions were not recognized",
        );
        const current = await cargo([
          "build",
          "--offline",
          "--locked",
          "--features",
          "alternate",
          "--message-format=json",
        ]);
        const artifacts = current.filter((entry) => isRecord(entry) && entry.reason === "compiler-artifact");
        const age = (path: string) => {
          if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name));
          else {
            const old = new Date(Date.now() - 20 * 86_400_000);
            utimesSync(path, old, old);
          }
        };
        for (const group of first.groups) for (const path of group.paths) age(join(directory, path));
        const result = await pruneRustCache(
          {
            directory: paths.directory,
            storageRoot: paths.storageRoot,
            identity: paths.identity,
            kind: "builds",
            tools: tools.filter((tool) => tool.tool === "rust"),
            platform: `${process.platform}-${process.arch}`,
            verifiedAt: new Date().toISOString(),
          },
          { maxAgeDays: 7, maxBytes: 0 },
          { apply: true },
        );
        assert(result.selected.some((group) => group.kind === RustArtifactKind.Build));
        assert(result.selected.some((group) => group.kind === RustArtifactKind.Incremental));
        for (const artifact of artifacts)
          if (isRecord(artifact) && Array.isArray(artifact.filenames))
            for (const path of artifact.filenames) {
              assert.equal(typeof path, "string");
              assert(existsSync(String(path)));
            }
        const reused = await cargo([
          "build",
          "--offline",
          "--locked",
          "--features",
          "alternate",
          "--message-format=json",
        ]);
        assert(
          reused.some((entry) => isRecord(entry) && entry.reason === "compiler-artifact" && entry.fresh === true),
          "Recent build artifacts were unnecessarily discarded",
        );
        await scope.run("cargo", ["test", "--offline", "--locked", "--features", "alternate"], {
          cwd: root,
          env: cargoEnv,
        });
        evidence.passed = true;
        evidence.removed = result.selected.map((group) => ({ id: group.id, kind: group.kind, bytes: group.bytes }));
        evidence.recentArtifactsReused = true;
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await settleCleanup(
        [
          () => {
            writeFileSync(join(report, "results.json"), JSON.stringify(evidence, null, 2));
          },
          () => {
            rmSync(temporary, { recursive: true, force: true });
          },
        ],
        failure,
      );
    }
  }, tools);
  console.log("Rust cache integration passed; evidence: " + report);
}
await main();
