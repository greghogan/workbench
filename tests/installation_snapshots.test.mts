import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { materializeDistribution } from "../src/runtime-distribution.ts";
import { distribution, git } from "./fixtures/adoption.mjs";
import { installationFixtures } from "./fixtures/installations.mjs";

const { fixture } = installationFixtures();

test("an exact installed release supplies the bundles for a fresh self-hosting image checkout", () => {
  const root = fixture(),
    project = join(root, "project"),
    installed = join(root, "installed"),
    snapshot = join(root, "snapshot");
  mkdirSync(project);
  mkdirSync(join(installed, "bundle"), { recursive: true });
  mkdirSync(join(snapshot, ".git"), { recursive: true });
  const manifest = JSON.stringify({ name: "@workbench/cli", files: ["bundle"], scripts: { prepare: "build" } });
  writeFileSync(join(project, "package.json"), manifest);
  writeFileSync(join(snapshot, "package.json"), manifest);
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@workbench/cli", files: ["bundle"] }));
  writeFileSync(join(installed, "workbench-source-manifest.json"), manifest);
  writeFileSync(join(installed, "bundle/launcher.cjs"), "packaged launcher");
  git(project, "init", "-q");
  git(project, "add", "package.json");
  git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Source");
  writeFileSync(
    join(installed, "workbench-source.json"),
    JSON.stringify({
      schema_version: 1,
      repository: "https://example.invalid/workbench",
      revision: git(project, "rev-parse", "HEAD").trim(),
    }),
  );

  expect(materializeDistribution(project, snapshot, installed)).toBe(snapshot);
  expect(readFileSync(join(snapshot, "bundle/launcher.cjs"), "utf8")).toBe("packaged launcher");
  expect(readFileSync(join(snapshot, "package.json"), "utf8")).toBe(manifest);

  writeFileSync(join(project, "new-source.ts"), "export {};\n");
  const dirty = join(root, "dirty");
  mkdirSync(join(dirty, ".git"), { recursive: true });
  expect(materializeDistribution(project, dirty, installed)).toBe(join(dirty, ".git/workbench/runtime"));
  expect(existsSync(join(dirty, "bundle"))).toBe(false);
});

test("CI snapshots materialize external runtimes without using the retained-originals directory", () => {
  const root = fixture(),
    project = join(root, "project"),
    snapshot = join(root, "snapshot");
  mkdirSync(project);
  mkdirSync(join(snapshot, ".git"), { recursive: true });
  const copied = materializeDistribution(project, snapshot, distribution);
  expect(copied).toBe(join(snapshot, ".git/workbench/runtime"));
  expect(
    readFileSync(join(copied, "bundle/main.cjs")).equals(readFileSync(join(distribution, "bundle/main.cjs"))),
    "bundle/main.cjs",
  ).toBe(true);
  expect(existsSync(join(snapshot, ".workbench"))).toBe(false);
  expect(existsSync(join(copied, "src"))).toBe(false);
  expect(existsSync(join(copied, "tests/installations.test.mts"))).toBe(false);
  for (const reference of [
    "LICENSE",
    "README.md",
    "docs/records.md",
    "bundle/main.cjs.br",
    "tests/fixtures/records/CHARTER.md",
    "examples/languages/python/pyproject.toml",
  ])
    expect(readFileSync(join(copied, reference)).equals(readFileSync(join(distribution, reference))), reference).toBe(
      true,
    );
});
