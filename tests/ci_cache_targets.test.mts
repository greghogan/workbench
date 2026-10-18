import type { Workflow } from "./fixtures/workflow.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import { configFromData } from "../src/core.ts";
import type { ToolAsset } from "../src/tool-downloads.ts";
import { cacheCheckout } from "./fixtures/cache-checkout.mjs";
import { ciCacheFixtures } from "./fixtures/ci-cache.mjs";

const repository = resolve(import.meta.dirname, "..");

const fixture = ciCacheFixtures();

test("CI cache keys isolate runtime targets and exclude oversized installations", () => {
  const root = fixture();
  const checkout = join(root, "checkout");
  cacheCheckout(repository, checkout);
  // This planning fixture never executes tools. Supply the selected Linux x64 artifacts on any test host.
  const assetsPath = join(checkout, "scripts/native-assets.json");
  const assets = JSON.parse(readFileSync(assetsPath, "utf8")) as Record<
    string,
    Record<string, Record<string, ToolAsset>>
  >;
  for (const versions of Object.values(assets))
    for (const platforms of Object.values(versions))
      if (platforms["linux-x64"]) platforms[`${process.platform}-${process.arch}`] = platforms["linux-x64"];
  writeFileSync(assetsPath, JSON.stringify(assets));
  const environment = join(root, "environment");
  const output = join(root, "output");
  const run = (version: string | undefined, runtime: string | null = "node", paths = ["."]) => {
    writeFileSync(environment, "");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [join(checkout, "scripts/ci-cache.mjs")], {
      cwd: checkout,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify({ runtime, version, paths }),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [required(match[1], "Output key"), required(match[2], "Output value")] as const,
      ),
    );
  };
  const versions = ["22.23.4", "24.22.1"];
  const registryPath = join(checkout, "workbench/projects.toml");
  // This consumer explicitly requests runtime compatibility; the reference matrix uses named profiles.
  writeFileSync(
    registryPath,
    readFileSync(registryPath, "utf8").replace("ci_compatibility = false", 'ci_versions = ["22.23.4", "24.22.1"]'),
  );
  expect(versions).toHaveLength(2);
  const oldest = run(versions[0]);
  const newest = run(versions[1]);
  expect(oldest["builds-key"]).not.toBe(newest["builds-key"]);
  expect(oldest["tools-key"]).toBeUndefined();
  expect(newest["tools-key"]).toBeUndefined();
  expect(oldest["tools-paths"]).not.toMatch(/toolchains[\\/](llvm|clang|gcc)/);
  expect(oldest["tools-paths"]).toBe("");
  expect(oldest["tools-paths"]).not.toContain(join(root, "workbench-ci", "cache", "toolchains", "vcpkg"));
  expect(oldest["tools-paths"]).not.toContain(join(root, "workbench-ci", "data"));
  expect(readFileSync(environment, "utf8")).toContain(
    `UV_PYTHON_INSTALL_DIR=${join(root, "workbench-ci", "cache", "uv-python", "python")}`,
  );
  if (process.platform === "win32") {
    expect(oldest["builds-paths"]).toBe(join(root, "workbench-ci", "cache", "go-build"));
    expect(oldest["downloads-paths"]).toContain(join(root, "workbench-ci", "cache", "downloads", "uv-python"));
  } else expect(oldest["builds-paths"]).toContain(join(root, "workbench-ci", "cache", "builds"));
  expect(oldest["builds-paths"]).not.toContain(join(root, "workbench-ci", "cache", "dependencies"));
  expect(oldest["builds-paths"]).not.toMatch(/\/nix\/store|\/gnu\/store/);
  expect(oldest["builds-paths"]).not.toContain("package-managers");
  expect(oldest["downloads-key"]).toBe(newest["downloads-key"]);
  expect(oldest["downloads-paths"]).toContain(join(root, "workbench-ci", "cache", "downloads/pnpm"));
  expect(oldest["downloads-paths"]).not.toContain(join(root, "workbench-ci", "cache", "builds"));
  expect(oldest["package-managers-paths"]).toContain(join(root, "workbench-ci", "cache", "package-managers"));
  expect(oldest["package-managers-key"]).toBe(newest["package-managers-key"]);
  expect(readFileSync(environment, "utf8")).toContain("WORKBENCH_STORAGE_EXTERNAL=true");
  for (const runtime of ["go", "java"]) {
    const path = `examples/languages/${runtime}`;
    const fields = run(undefined, null, [path]);
    expect(required(fields["tools-paths"], 'Fixture value fields["tools-paths"]').replaceAll("\\", "/")).not.toContain(
      `/toolchains/${runtime}/`,
    );
    // Maven remains selected independently of the JDK installation.
    if (runtime === "java")
      expect(required(fields["tools-paths"], 'Fixture value fields["tools-paths"]').replaceAll("\\", "/")).toContain(
        "/toolchains/maven/",
      );
    else expect(fields["tools-key"]).toBeUndefined();
  }
  const configPath = join(checkout, "workbench/config.toml");
  const config = configFromData(parseTOML(readFileSync(configPath, "utf8")), undefined, configPath);
  const downloadedGCC = process.platform === "linux" ? run("16.2.0", "gcc", ["examples/languages/c"]) : undefined;
  required(config.ci, "Expected fixture value: config.ci").cache = {
    artifacts: { node: "cache", gcc: "cache", llvm: "cache", clang: "download", rust: "download" },
  };
  writeFileSync(configPath, stringifyTOML(config));
  if (downloadedGCC) {
    expect(
      required(downloadedGCC["tools-paths"], 'Fixture value downloadedGCC["tools-paths"]').replaceAll("\\", "/"),
    ).not.toContain("/toolchains/gcc/");
    expect(downloadedGCC["llvm-key"]).toBeUndefined();
    const retainedGCC = run("16.2.0", "gcc", ["examples/languages/c"]);
    expect(
      required(retainedGCC["tools-paths"], 'Fixture value retainedGCC["tools-paths"]').replaceAll("\\", "/"),
    ).toContain("/toolchains/gcc/16.2.0/");
    expect(retainedGCC["tools-key"]).not.toBe(downloadedGCC["tools-key"]);
    expect(
      required(retainedGCC["llvm-paths"], 'Fixture value retainedGCC["llvm-paths"]').replaceAll("\\", "/"),
    ).not.toContain("/toolchains/gcc/");
    const olderGCC = run("14.4.0", "gcc", ["examples/languages/c"]);
    expect(olderGCC["tools-key"]).not.toBe(retainedGCC["tools-key"]);
    expect(olderGCC["llvm-key"]).toBe(retainedGCC["llvm-key"]);
  }
  required(required(required(config.ci, "CI config").cache, "CI cache").artifacts, "Artifact policies").llvm =
    "download";
  writeFileSync(configPath, stringifyTOML(config));
  const retainedNode = run(versions[0]);
  expect(retainedNode["tools-key"]).toBeDefined();
  expect(
    required(retainedNode["tools-paths"], 'Fixture value retainedNode["tools-paths"]').replaceAll("\\", "/"),
  ).toContain("/toolchains/node/");
  const noLLVM = run("21.1.8", "clang", ["examples/languages/c"]);
  expect(noLLVM["llvm-key"]).toBeUndefined();
  expect(noLLVM["clang-key"]).toBeUndefined();
  expect(run(undefined, null, ["examples/languages/rust"])["rust-key"]).toBeUndefined();
});

test.skipIf(process.platform !== "linux")(
  "opt-in LLVM caches contain only selected retained installations and are saved after verification",
  () => {
    const root = fixture();
    const checkout = join(root, "checkout");
    cacheCheckout(repository, checkout);
    const configPath = join(checkout, "workbench/config.toml");
    const config = configFromData(parseTOML(readFileSync(configPath, "utf8")), undefined, configPath);
    required(config.ci, "Expected fixture value: config.ci").cache = { artifacts: { llvm: "cache", clang: "cache" } };
    writeFileSync(configPath, stringifyTOML(config));
    const environment = join(root, "environment");
    const output = join(root, "output");
    const keys = [];
    for (const version of ["21.1.8", "22.1.8", "23.1.4"]) {
      writeFileSync(environment, "");
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, [join(checkout, "scripts/ci-cache.mjs")], {
        cwd: checkout,
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          GITHUB_ENV: environment,
          GITHUB_OUTPUT: output,
          CACHE_TARGET: JSON.stringify({ runtime: "clang", version, paths: ["examples/languages/c"] }),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const fields = Object.fromEntries(
        [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
          (match) => [required(match[1], "Output key"), required(match[2], "Output value")] as const,
        ),
      );
      keys.push(fields["llvm-key"]);
      expect(fields["llvm-key"]).toMatch(/^llvm-v3-/);
      expect(fields["llvm-paths"]).toContain(join(root, "workbench-ci", "cache", "toolchains", "llvm"));
      expect(fields["llvm-paths"]).not.toContain("downloads");
      expect(
        required(fields["llvm-paths"], 'Fixture value fields["llvm-paths"]')
          .split("\n")
          .filter((path: string | string[]) => path.includes("toolchains/llvm/")),
      ).toHaveLength(1);
      if (version !== "23.1.4") expect(fields["clang-paths"]).toContain(join("toolchains", "clang", version));
      else expect(fields["clang-key"]).toBeUndefined();
      expect(fields["llvm-paths"]).not.toContain(join("toolchains", "clang"));
    }
    expect(new Set(keys).size).toBe(1);
    const workflow = parse(readFileSync(join(repository, ".github/workflows/checks.yml"), "utf8")) as Workflow;
    const retained = workflow.jobs.native.steps.find((step) => step.id === "llvm-cache");
    expect(required(retained, "Fixture value retained").uses).toContain("actions/cache@");
    expect(required(required(retained, "Fixture value retained").with, "Cache action options").path).toContain(
      "llvm-paths",
    );
    expect(required(retained, "Fixture value retained").if).toContain("persistence.outputs.container");
  },
);

test("CI retains selected Rust versions and the tool versions installed inside Dev Containers", () => {
  const root = fixture();
  const run = (target: { paths: string[]; runtime?: string; version?: string; environment?: string }) => {
    const output = join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [join(repository, "scripts/ci-cache.mjs")], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, "environment"),
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify(target),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [required(match[1], "Output key"), required(match[2], "Output value")] as const,
      ),
    );
  };
  const rust = run({ paths: ["examples/languages/rust"] });
  expect(rust["rust-paths"]).toContain(join(root, "workbench-ci/cache/ci/rustup/toolchains/1.99.1-*"));
  expect(rust["rust-paths"]).not.toContain("nightly");
  expect(rust["rust-paths"]).not.toContain("downloads");
  const msrv = run({ paths: ["examples/languages/rust"], runtime: "rust", version: "1.93.0" });
  expect(msrv["rust-key"]).not.toBe(rust["rust-key"]);
  expect(msrv["rust-paths"]).toContain("1.93.0-*");
  expect(msrv["rust-paths"]).not.toContain("1.99.1");
  const c = run({ paths: ["examples/languages/c"] });
  expect(c["tools-key"]).toMatch(/^tools-v8-/);
  const both = run({ paths: ["examples/languages/c", "examples/languages/cpp"] });
  const reversed = run({ paths: ["examples/languages/cpp", "examples/languages/c"] });
  expect(both["tools-key"]).toBe(c["tools-key"]);
  expect(reversed["tools-key"]).toBe(c["tools-key"]);
  expect(both["tools-paths"]).toBe(c["tools-paths"]);
  expect(both["guix-key"]).toBe(c["guix-key"]);
  expect(reversed["guix-key"]).toBe(c["guix-key"]);
  const guix = run({ paths: ["examples/languages/c"], environment: "guix" });
  const guixBoth = run({ paths: ["examples/languages/cpp", "examples/languages/c"], environment: "guix" });
  expect(guixBoth["guix-bootstrap-key"]).toBe(guix["guix-bootstrap-key"]);
  expect(guix["guix-bootstrap-path"]).toContain("guix-bootstrap");
  expect(c["guix-bootstrap-key"]).toBeUndefined();
  const guest = run({
    paths: ["examples/languages/cpp", "examples/languages/java", "examples/languages/python"],
    environment: "devcontainer",
  });
  expect(guest["llvm-key"]).toBeUndefined();
  expect(guest["llvm-paths"]).toBeUndefined();
  expect(guest["clang-key"]).toBeUndefined();
  expect(guest["tools-paths"]).not.toContain(join(root, "workbench-ci/cache/toolchains/llvm"));
  expect(guest["tools-paths"]).toContain(join(root, "workbench-ci/cache/toolchains/maven"));
  const redownload = [
    "llvm",
    "clang",
    "java",
    "node",
    "go",
    "cmake",
    "ninja",
    "uv",
    "shfmt",
    "shellcheck",
    "actionlint",
    "cargo-nextest",
    "cargo-llvm-cov",
  ];
  for (const fields of [c, both, reversed, guest, rust, msrv])
    for (const tool of redownload)
      expect(
        required(fields["tools-paths"], 'Fixture value fields["tools-paths"]').replaceAll("\\", "/"),
      ).not.toContain(`/toolchains/${tool}/`);
  const pythonInstall = join(root, "workbench-ci/cache/uv-python/python");
  if (process.platform === "win32") expect(guest["tools-paths"]).not.toContain(pythonInstall);
  else expect(guest["tools-paths"]).toContain(pythonInstall);
  expect(guest["tools-paths"]).not.toMatch(/\/nix\/store|\/gnu\/store/);
});
