import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { materializeDistribution } from "../src/runtime-distribution.ts";
import { distribution } from "./fixtures/adoption.mjs";
import { installationFixtures } from "./fixtures/installations.mjs";

const { fixture } = installationFixtures();

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
