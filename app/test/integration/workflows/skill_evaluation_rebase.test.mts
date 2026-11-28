import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { command, verifyOutcome, prepare, write } from "../../../../scripts/skill-evaluation-cases.mjs";
import { rebaseCases } from "../../../../scripts/skill-evaluation-rebase.mjs";
import { skillEvaluationFixtures } from "../../fixtures/skill-evaluation.mjs";

const fixture = skillEvaluationFixtures();

test.each(Object.keys(rebaseCases) as (keyof typeof rebaseCases)[])(
  "%s evaluates real Git outcomes and rejects a broken resolution or refusal",
  (name) => {
    const { root, env } = fixture();
    const git = (...args: string[]) => command(root, env, "git", args);

    const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, name);
    assert.ok("rebase" in before && before.rebase);
    const rebase = before.rebase;
    if (name.startsWith("rebase-dirty-") || name === "rebase-in-progress") {
      verifyOutcome(root, env, name, before);
      if (name === "rebase-in-progress") git("rebase", "--abort");
      else write(root, "unfinished.txt", "Changed developer work.\n");
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      }, /refusal changed/);
      return;
    }
    if (name !== "rebase-policy")
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      });
    git("fetch", "origin");
    git("update-ref", "refs/workbench/rebase/evaluation", rebase.original);
    if (name === "rebase-clean") git("rebase", "--no-autostash", "--no-update-refs", rebase.target);
    else {
      assert.throws(() => {
        git("rebase", "--no-autostash", "--no-update-refs", rebase.target);
      });
      if (name === "rebase-policy") {
        verifyOutcome(root, env, name, before);
        git("checkout", "--ours", "--", "workbench/decisions/ADR-20.md");
      } else {
        write(root, "display.mjs", 'export function label(name) { return "Item: " + name.trim(); }\n');
        write(
          root,
          "topic-label.test.mjs",
          readFileSync(join(root, "topic-label.test.mjs"), "utf8").replace("./labels.mjs", "./display.mjs"),
        );
        git("rm", "--", "legacy-labels.md");
        command(root, env, process.execPath, ["generate-labels.mjs"]);
      }
      git("add", ".");
      git("-c", "core.editor=true", "rebase", "--continue");
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      });
      if (name === "rebase-policy") return;
      write(root, "display.mjs", 'export function label(name) { return "Item: " + (name.trim() || "unknown"); }\n');
      command(root, env, process.execPath, ["generate-labels.mjs"]);
      git("add", ".");
      git("commit", "--amend", "--no-edit", "--quiet");
    }
    verifyOutcome(root, env, name, before);
    if (name === "rebase-clean") {
      const fetchHead = git("rev-parse", "--git-path", "FETCH_HEAD").trim();
      rmSync(join(root, fetchHead));
      assert.throws(() => {
        verifyOutcome(root, env, name, before);
      }, /target was not fetched/);
    }
  },
);
