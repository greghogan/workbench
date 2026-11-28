import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import { provisionalFixtures } from "../../fixtures/provisional-commits.mjs";

const { project } = provisionalFixtures();

test("commit gates retain required human review, agent review, and source quality checks", async () => {
  const { f, base } = await project();
  const ordinary = f.cli("commit", "-m", "feat: record draft");
  expect(ordinary.status).not.toBe(0);
  expect(ordinary.stderr).toContain("human review");
  const unreviewed = f.cli("commit", "--provisional", "-m", "feat: record draft");
  expect(unreviewed.status).not.toBe(0);
  expect(unreviewed.stderr).toContain("Change review is required");
  writeFileSync(join(f.root, "source.txt"), "bad");
  git(f.root, "add", ".");
  f.review();
  const failed = f.cli("commit", "--provisional", "-m", "feat: record draft");
  expect(failed.status).not.toBe(0);
  expect(failed.stdout + failed.stderr).toContain("Source quality");
  expect(git(f.root, "rev-parse", "HEAD")).toBe(base);
});
