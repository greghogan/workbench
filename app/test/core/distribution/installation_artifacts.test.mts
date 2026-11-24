import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  distributionInputHash,
  inspectDistribution,
  sealDistribution,
} from "../../../src/core/distribution/distribution-manifest.ts";
import { materializeDistribution } from "../../../src/core/distribution/runtime-distribution.ts";
import { copySourceCheckout } from "../../../src/core/execution/snapshots/source-checkout.mjs";
import { prepareWorkbenchPackage } from "../../../src/core/artifacts/package.ts";
import { distribution } from "../../fixtures/adoption.mjs";
import { installationFixtures, pin } from "../../fixtures/installations.mjs";
import { goCountFixture } from "../../fixtures/go-starter.mjs";

const { fixture } = installationFixtures();

test("artifact seals permit omitted reference sources while rejecting unsealed files", () => {
  const root = fixture();
  for (const name of ["bin", "bundle", "languages", "workbench", "app/src"])
    mkdirSync(join(root, name), { recursive: true });
  for (const name of [
    "bin/workbench.mjs",
    "bundle/main.cjs",
    "languages/index.toml",
    "workbench/projects.toml",
    "app/src/reference.ts",
  ])
    writeFileSync(join(root, name), "fixture\n");
  const sealed = sealDistribution(root, pin.revision);
  expect(inspectDistribution(root, sealed).pin).toEqual(sealed);
  const digest = distributionInputHash(root, "app/src/reference.ts");
  rmSync(join(root, "app"), { recursive: true });
  expect(distributionInputHash(root, "app/src/reference.ts")).toBe(digest);
  writeFileSync(join(root, "extra"), "unexpected");
  expect(() => inspectDistribution(root, sealed)).toThrow(/unsealed/);
});

test("artifact seals reject changed bytes, renamed paths, permissions, and redirected links", () => {
  const root = fixture();
  for (const name of ["bin", "bundle", "languages", "workbench"]) mkdirSync(join(root, name));
  for (const name of ["bin/workbench.mjs", "bundle/main.cjs", "languages/index.toml", "workbench/projects.toml"])
    writeFileSync(join(root, name), "sealed bytes\n", { mode: 0o644 });
  const file = join(root, "bundle/main.cjs");
  const alias = join(root, "bundle/alias.cjs");
  if (process.platform !== "win32") symlinkSync("main.cjs", alias);
  const sealed = sealDistribution(root, pin.revision);
  writeFileSync(file, "changed bytes\n");
  expect(() => inspectDistribution(root, sealed)).toThrow(/main\.cjs: distribution content differs/);
  writeFileSync(file, "sealed bytes\n");
  if (process.platform !== "win32") {
    chmodSync(file, 0o755);
    expect(() => inspectDistribution(root, sealed)).toThrow(/executable permission differs/);
    chmodSync(file, 0o644);
    rmSync(alias);
    symlinkSync("../bin/workbench.mjs", alias);
    expect(() => inspectDistribution(root, sealed)).toThrow(/distribution link differs/);
    rmSync(alias);
    symlinkSync("main.cjs", alias);
  }
  renameSync(file, file + ".renamed");
  expect(() => inspectDistribution(root, sealed)).toThrow(/unsealed/);
  renameSync(file + ".renamed", file);
  expect(inspectDistribution(root, sealed).pin).toEqual(sealed);
});

test("runtime snapshots and executable packages include hooks and exclude personal direnv state", async () => {
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
  await prepareWorkbenchPackage(source, { output });
  for (const destination of [copied, join(output, "workbench")]) {
    expect(readFileSync(join(destination, "examples/app/.envrc"), "utf8")).toBe(hook);
    expect(existsSync(join(destination, "examples/app/.envrc.local"))).toBe(false);
    expect(existsSync(join(destination, "examples/app/.direnv"))).toBe(false);
  }
  expect(readFileSync(join(source, "examples/app/.envrc.local"), "utf8")).toBe(personal);
  expect(readFileSync(join(source, "examples/app/.direnv/cache"), "utf8")).toBe("personal state\n");
});

test("the executable package verifies independent adoption and includes references without development dependencies", async () => {
  const root = fixture(),
    source = join(root, "source"),
    output = join(root, "artifacts");
  copySourceCheckout(distribution, source);
  copyFileSync(goCountFixture, join(source, "examples/languages/go/count.go"));
  const generated = readdirSync(join(distribution, "bundle"))
    .filter((name) => !name.startsWith("."))
    .map((name) => ({ path: `bundle/${name}`, contents: readFileSync(join(distribution, "bundle", name)) }));
  await prepareWorkbenchPackage(source, { output, generated });
  const packaged = join(output, "workbench");
  const manifest = JSON.parse(readFileSync(join(packaged, "package.json"), "utf8")) as Record<string, unknown>;
  expect(
    readFileSync(join(packaged, "workbench-source-manifest.json")).equals(
      readFileSync(join(distribution, "package.json")),
    ),
    "workbench-source-manifest.json",
  ).toBe(true);
  expect(manifest.devDependencies).toBeUndefined();
  expect(manifest.license).toBe("Apache-2.0");
  expect(readFileSync(join(packaged, "LICENSE")).equals(readFileSync(join(distribution, "LICENSE"))), "LICENSE").toBe(
    true,
  );
  expect(existsSync(join(packaged, "node_modules"))).toBe(false);
  expect(existsSync(join(packaged, "app/src/core/records/records.ts"))).toBe(false);
  expect(existsSync(join(packaged, "app/test/core/distribution/installations.test.mts"))).toBe(false);
  for (const reference of [
    "LICENSE",
    "README.md",
    "docs/records.md",
    "bundle/main.cjs",
    "app/resources/verification/CHARTER.md",
    "examples/languages/python/pyproject.toml",
  ])
    expect(readFileSync(join(packaged, reference)).equals(readFileSync(join(distribution, reference))), reference).toBe(
      true,
    );
  // Verification must execute the archive even when the staging directory no longer exists.
  rmSync(packaged, { recursive: true });
  const verify = () =>
    spawnSync(process.execPath, [join(distribution, "scripts/check-release.mjs"), output, source], {
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

test("executable packaging leaves independent providers and local policy outside the distribution", async () => {
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
  await prepareWorkbenchPackage(root, { output });
  expect(
    readFileSync(join(output, "workbench/bin/runner.mjs")).equals(readFileSync(join(root, "bin/runner.mjs"))),
    "bin/runner.mjs",
  ).toBe(true);
  for (const directory of ["collections", "workbench"])
    expect(existsSync(join(output, "workbench", directory))).toBe(false);
  expect(readFileSync(join(root, "collections/company/policy.md"), "utf8")).toBe("Independent provider policy.\n");
});
