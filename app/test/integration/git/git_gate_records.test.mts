import { required } from "../../../src/core/runtime/invariants.ts";
import { approveReview } from "../../../src/core/review/review-approval.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { consumerHookFixtures } from "../../fixtures/consumer-hooks.mjs";

const consumer = consumerHookFixtures();

test("consumer hooks protect committed records while allowing removal of exported copies", () => {
  const { root, git, workbench, gate, rejected } = consumer();
  workbench("record", "add", "task", "Retained task");
  const providerRecord = "exports/company/1/workbench/decisions/ADR-00.md";
  mkdirSync(join(root, "exports/company/1/workbench/decisions"), { recursive: true });
  writeFileSync(join(root, providerRecord), "# Exported provider decision\n");
  git(root, "add", ".");
  const baselineDigest = required(
    /Review digest: ([a-f0-9]{64})/.exec(workbench("review")),
    'Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(workbench("review"))',
  )[1];
  approveReview(root, required(baselineDigest, "Expected fixture value"), true);
  git(root, "commit", "-qm", "feat: establish consumer");
  git(root, "rm", providerRecord);
  assert.match(workbench("review"), /No protected record changes/);
  const removedExport = gate();
  assert.equal(removedExport.status, 0, removedExport.stdout + removedExport.stderr);
  git(root, "rm", "workbench/tasks/TSK-00.md");
  assert.match(rejected(), /retain committed records/);
});
