import { required } from "../../../src/core/runtime/invariants.ts";
import { approveReview } from "../../../src/core/review/review-approval.js";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { consumerHookFixtures } from "../../fixtures/consumer-hooks.mjs";

const consumer = consumerHookFixtures();

test("consumer hooks use the installed command and validate only the staged project and local preferences", () => {
  const { root, config, git, workbench, gate, rejected } = consumer();
  const review = workbench("review");
  const digest = required(
    /Review digest: ([a-f0-9]{64})/.exec(review),
    "Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(review)",
  )[1];
  assert.match(rejected(), /human review/);
  approveReview(root, required(digest, "Expected fixture value"), true);
  const initial = gate();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);

  // The staged gate reads execution preferences from the working checkout without copying them into the snapshot.
  const local = join(root, "workbench/local.toml");
  writeFileSync(local, '[checks]\nenvironment="invalid"\n');
  assert.equal(git(root, "check-ignore", "workbench/local.toml"), "workbench/local.toml");
  assert.match(rejected(), /local\.toml:\s+checks\.environment/);
  rmSync(local);

  // Unstaged structural damage must not contaminate the staged tree.
  writeFileSync(config, "invalid TOML [\n");
  const isolated = gate();
  assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);
  git(root, "checkout", "--", "workbench/config.toml");
});
