import { gitNullConfiguration } from "../src/windows-host.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { command, verifyOutcome, prepare, workbench, write } from "../scripts/skill-evaluation-cases.mjs";

test("evaluation rejects unchanged defects and advisory edits, then accepts corrected behavior", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-evaluation-contract-"));
  const root = join(temporary, "project");
  mkdirSync(root);
  const env = {
    ...process.env,
    WORKBENCH_CONFIG_HOME: join(temporary, "user"),
    GIT_CONFIG_GLOBAL: gitNullConfiguration,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    const before = prepare(root, resolve(import.meta.dirname, ".."), env, "review");
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
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test.each(["adoption", "recovery", "policy-handoff", "commit-push"] as const)(
  "%s workflow has an executable positive and negative workflow contract",
  (name) => {
    const temporary = mkdtempSync(join(tmpdir(), "workbench-workflow-evaluation-"));
    const root = join(temporary, "project");
    mkdirSync(root);
    const env = {
      ...process.env,
      WORKBENCH_CONFIG_HOME: join(temporary, "user"),
      WORKBENCH_CACHE_HOME: join(temporary, "cache"),
      WORKBENCH_DATA_HOME: join(temporary, "data"),
      WORKBENCH_STATE_HOME: join(temporary, "state"),
      GIT_CONFIG_GLOBAL: gitNullConfiguration,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    try {
      const before = prepare(root, resolve(import.meta.dirname, ".."), env, name);
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
        if (name === "commit-push") {
          command(root, env, "git", ["add", "."]);
          command(root, env, "git", ["commit", "-qm", "Fix basket quantities"]);
          command(root, env, "git", ["push", "--quiet", "origin", "main"]);
        }
      }
      verifyOutcome(root, env, name, before);
      if (name === "policy-handoff") {
        write(root, "basket.mjs", "export function total() { return 1.08; }\n");
        assert.throws(() => {
          verifyOutcome(root, env, name, before);
        }, /changed existing project/);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
