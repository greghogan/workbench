import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import { collectionRepository } from "../../../src/core/collections/collection-git.ts";
import { snapshotCIProject } from "../../../src/core/execution/ci/ci-workspace.ts";
import { collectionWorkflowFixtures } from "../../fixtures/collection-workflow.mjs";

const { prepare } = collectionWorkflowFixtures();

test("a CI snapshot preserves the committed pin of a deinitialized collection", async () => {
  const { root, scratch, source, cli } = await prepare();
  git(root, "add", ".");
  cli(root, "collection", "stage", "company");
  git(root, "commit", "-qm", "Pin the fixture collection");
  git(root, "submodule", "deinit", "-f", "--all");
  expect(readdirSync(join(root, ".workbench/collections/company"))).toEqual([]);
  const snapshot = join(scratch, "snapshot");
  await snapshotCIProject(root, snapshot);
  expect(git(snapshot, "ls-files", "--stage", ".workbench/collections/company")).toBe(
    `160000 ${source.commit} 0\t.workbench/collections/company`,
  );
  expect(existsSync(join(snapshot, ".workbench/collections/company/workbench"))).toBe(false);
  expect(existsSync(collectionRepository(snapshot, "company"))).toBe(false);
});
