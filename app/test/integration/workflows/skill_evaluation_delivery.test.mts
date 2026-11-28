import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { command, verifyOutcome, prepare, write } from "../../../../scripts/skill-evaluation-cases.mjs";
import { skillEvaluationFixtures } from "../../fixtures/skill-evaluation.mjs";

const fixture = skillEvaluationFixtures();

test.each(["recovery", "commit-push"] as const)(
  "%s workflow has an executable positive and negative workflow contract",
  (name) => {
    const { root, env } = fixture();
    const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, name);
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    });
    write(
      root,
      "basket.mjs",
      "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
    );
    if (name === "commit-push") {
      command(root, env, "git", ["add", "."]);
      command(root, env, "git", ["commit", "-qm", "Fix basket quantities"]);
      command(root, env, "git", ["push", "--quiet", "origin", "main"]);
    }
    verifyOutcome(root, env, name, before);
  },
);
