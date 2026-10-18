import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { distributionInputHash, inspectDistribution, sealDistribution } from "../src/distribution-manifest.ts";
import { materializeDistribution } from "../src/runtime-distribution.ts";
import { distribution } from "./fixtures/adoption.mjs";
import { installationFixtures, pin } from "./fixtures/installations.mjs";

const { fixture } = installationFixtures();

test("artifact seals bind bytes, executable permissions, paths and links", () => {
  const root = fixture();
  for (const name of ["bin", "bundle", "languages", "workbench", "src"]) mkdirSync(join(root, name));
  for (const name of [
    "bin/workbench.mjs",
    "bundle/main.cjs",
    "languages/index.toml",
    "workbench/projects.toml",
    "src/reference.ts",
  ])
    writeFileSync(join(root, name), "fixture\n");
  const sealed = sealDistribution(root, pin.revision);
  expect(inspectDistribution(root, sealed).pin).toEqual(sealed);
  const digest = distributionInputHash(root, "src/reference.ts");
  rmSync(join(root, "src"), { recursive: true });
  expect(distributionInputHash(root, "src/reference.ts")).toBe(digest);
  writeFileSync(join(root, "extra"), "unexpected");
  expect(() => inspectDistribution(root, sealed)).toThrow(/unsealed/);
});

test("runtime snapshots and executable packages include hooks and exclude personal direnv state", () => {
  const root = fixture(),
    source = join(root, "source"),
    project = join(root, "project"),
    output = join(root, "artifacts");
  mkdirSync(project);
  mkdirSync(join(source, "examples/app/.direnv"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture", files: ["examples"] }));
  const hook = "export ROOT_SETTING=example\n",
    personal = "export PERSONAL=private\n";
  writeFileSync(join(source, "examples/app/.envrc"), hook);
  writeFileSync(join(source, "examples/app/.envrc.local"), personal);
  writeFileSync(join(source, "examples/app/.direnv/cache"), "personal state\n");
  const copied = materializeDistribution(project, join(root, "snapshot"), source);
  const packaged = spawnSync(process.execPath, [join(distribution, "scripts/package-workbench.mjs")], {
    cwd: source,
    env: { ...process.env, WORKBENCH_RELEASE_OUTPUT: output },
    encoding: "utf8",
  });
  expect(packaged.status, packaged.stdout + packaged.stderr).toBe(0);
  for (const destination of [copied, join(output, "workbench")]) {
    expect(readFileSync(join(destination, "examples/app/.envrc"), "utf8")).toBe(hook);
    expect(existsSync(join(destination, "examples/app/.envrc.local"))).toBe(false);
    expect(existsSync(join(destination, "examples/app/.direnv"))).toBe(false);
  }
  expect(readFileSync(join(source, "examples/app/.envrc.local"), "utf8")).toBe(personal);
  expect(readFileSync(join(source, "examples/app/.direnv/cache"), "utf8")).toBe("personal state\n");
});

test("the executable package verifies independent adoption and includes references without development dependencies", () => {
  const root = fixture(),
    output = join(root, "artifacts");
  const prepared = spawnSync(process.execPath, [join(distribution, "scripts/package-workbench.mjs")], {
    cwd: distribution,
    env: { ...process.env, WORKBENCH_RELEASE_OUTPUT: output, WORKBENCH_PROJECT_ROOT: distribution },
    encoding: "utf8",
  });
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  const packaged = join(output, "workbench");
  const manifest = JSON.parse(readFileSync(join(packaged, "package.json"), "utf8")) as Record<string, unknown>;
  expect(manifest.devDependencies).toBeUndefined();
  expect(manifest.license).toBe("Apache-2.0");
  expect(readFileSync(join(packaged, "LICENSE"))).toEqual(readFileSync(join(distribution, "LICENSE")));
  expect(existsSync(join(packaged, "node_modules"))).toBe(false);
  for (const reference of [
    "LICENSE",
    "README.md",
    "docs/records.md",
    "src/main.ts",
    "tests/installations.test.mts",
    "examples/languages/python/pyproject.toml",
  ])
    expect(readFileSync(join(packaged, reference))).toEqual(readFileSync(join(distribution, reference)));
  // Verification must execute the archive even when the staging directory no longer exists.
  rmSync(packaged, { recursive: true });
  const verify = () =>
    spawnSync(process.execPath, [join(distribution, "scripts/check-release.mjs"), output, distribution], {
      cwd: distribution,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: distribution },
      encoding: "utf8",
    });
  const verified = verify();
  expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  const archive = join(output, "workbench-artifacts/workbench.tar.gz");
  writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("changed archive")]));
  const changed = verify();
  expect(changed.status).not.toBe(0);
  expect(changed.stderr).toContain("release archive checksum mismatch");
});

test("executable packaging leaves independent providers and local policy outside the distribution", () => {
  const root = fixture();
  for (const directory of ["bin", "collections/company", "workbench/.local-collections/company"])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "bin/runner.mjs"), "export const fixture = true;\n");
  for (const directory of ["collections/company", "workbench/.local-collections/company"])
    writeFileSync(join(root, directory, "policy.md"), "Independent provider policy.\n");
  const files = (JSON.parse(readFileSync(join(distribution, "package.json"), "utf8")) as { files: string[] }).files;
  expect(files).not.toContain("collections");
  expect(files).not.toContain("workbench");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1", files: ["bin"] }));
  const output = join(root, "dist");
  const result = spawnSync(process.execPath, [join(distribution, "scripts/package-workbench.mjs")], {
    cwd: root,
    env: { ...process.env, WORKBENCH_RELEASE_OUTPUT: output },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(output, "workbench/bin/runner.mjs"))).toEqual(readFileSync(join(root, "bin/runner.mjs")));
  for (const directory of ["collections", "workbench"])
    expect(existsSync(join(output, "workbench", directory))).toBe(false);
  expect(readFileSync(join(root, "collections/company/policy.md"), "utf8")).toBe("Independent provider policy.\n");
});
