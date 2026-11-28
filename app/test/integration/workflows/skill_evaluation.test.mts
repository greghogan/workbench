import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { command, verifyOutcome, prepare, workbench, write } from "../../../../scripts/skill-evaluation-cases.mjs";
import { skillEvaluationFixtures } from "../../fixtures/skill-evaluation.mjs";

const fixture = skillEvaluationFixtures();

test("the documented evaluation command loads in ordinary Node", () => {
  const { root, env } = fixture();
  const help = command(root, env, process.execPath, [
    resolve(import.meta.dirname, "../../../../scripts/evaluate-skills.mjs"),
    "--help",
  ]);
  assert.match(help, /Scenarios: .*review-interface/);
});

test("evaluation rejects unchanged defects and advisory edits, then accepts corrected behavior", () => {
  const { root, env } = fixture();

  const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, "review");
  assert.ok(existsSync(join(env.WORKBENCH_CONFIG_HOME, "config.toml")));
  assert.ok(!existsSync(join(root, ".workbench-evaluation-config")));
  verifyOutcome(root, env, "refactors", before);
  assert.throws(() => {
    verifyOutcome(root, env, "review", before);
  });
  write(
    root,
    "basket.mjs",
    "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
  );
  assert.throws(() => {
    verifyOutcome(root, env, "refactors", before);
  }, /advisory request changed project files/);
  verifyOutcome(root, env, "review", before);
});

test.each(["adoption", "policy-handoff", "bugs", "bugs-clean"] as const)(
  "%s workflow has an executable positive and negative workflow contract",
  (name) => {
    const { root, env } = fixture();

    const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, name);
    if (name === "bugs-clean") {
      verifyOutcome(root, env, name, before);
      write(root, "unnecessary.txt", "An unsupported proposed repair.\n");
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      }, /unfounded bug allegation changed project files/);
      return;
    }
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    });
    if (name === "adoption") {
      workbench(
        root,
        env,
        "init",
        ".",
        "--id",
        "fixture",
        "--adopt",
        "--no-workbench-collection",
        "--language",
        "javascript",
        "--check",
        "node --test",
      );
      write(root, "workbench/CHARTER.md", readFileSync(join(root, "INTENT.md")));
      workbench(root, env, "sync");
    } else if (name === "policy-handoff") {
      write(root, "POLICY-QUESTION.md", "Which jurisdiction and tax rate should apply?\n");
    } else {
      write(
        root,
        "basket.mjs",
        "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
      );
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      }, /retained regression did not fail/);
      write(
        root,
        "basket.test.mjs",
        readFileSync(join(root, "basket.test.mjs"), "utf8") +
          'test("zero quantity", () => assert.equal(total([{price: 10, quantity: 0}]), 0));\n',
      );
    }
    verifyOutcome(root, env, name, before);
    if (name === "policy-handoff") {
      write(root, "basket.mjs", "export function total() { return 1.08; }\n");
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      }, /changed existing project/);
    }
  },
);
