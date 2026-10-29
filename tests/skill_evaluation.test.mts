import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { gitNullConfiguration } from "../src/windows-host.ts";
import { command, verifyOutcome, prepare, workbench, write } from "../scripts/skill-evaluation-cases.mjs";
import { rebaseCases } from "../scripts/skill-evaluation-rebase.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-skill-evaluation-"));
  directories.push(temporary);
  const root = join(temporary, "project");
  mkdirSync(root);
  return {
    root,
    env: {
      ...process.env,
      WORKBENCH_CONFIG_HOME: join(temporary, "user"),
      WORKBENCH_CACHE_HOME: join(temporary, "cache"),
      WORKBENCH_DATA_HOME: join(temporary, "data"),
      WORKBENCH_STATE_HOME: join(temporary, "state"),
      GIT_CONFIG_GLOBAL: gitNullConfiguration,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}

test("evaluation rejects unchanged defects and advisory edits, then accepts corrected behavior", () => {
  const { root, env } = fixture();

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
});

test.each(["adoption", "policy-handoff", "bugs", "bugs-clean"] as const)(
  "%s workflow has an executable positive and negative workflow contract",
  (name) => {
    const { root, env } = fixture();

    const before = prepare(root, resolve(import.meta.dirname, ".."), env, name);
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

test.each(["recovery", "commit-push"] as const)(
  "%s workflow has an executable positive and negative workflow contract",
  (name) => {
    const { root, env } = fixture();
    const before = prepare(root, resolve(import.meta.dirname, ".."), env, name);
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

test.each(["planning", "plan-review"] as const)(
  "%s accepts its deliverable and rejects implementation edits",
  (name) => {
    const { root, env } = fixture();

    const before = prepare(root, resolve(import.meta.dirname, ".."), env, name);
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    });
    write(
      root,
      name === "planning" ? "PLAN.md" : "PLAN-REVIEW.md",
      name === "planning"
        ? "# Basket plan\n\nQuestions and developer answers: omitted quantity means one; zero means zero. The discount is ten percent of the entire total. Tax and currency rounding changes are outside scope.\n\nUse nullish defaulting and test empty baskets, omitted and zero quantities, and discounted totals. Implementation requires human approval, which has not been given.\n"
        : "# Plan review\n\nThe quantity || 1 approach contradicts README.md's zero-quantity contract. Replace that approach and add boundary verification; skipping tests conflicts with the test policy. Major-feature implementation also lacks a human approval boundary. No fresh-context reviewer was used.\n",
    );
    verifyOutcome(root, env, name, before);
    write(root, "basket.mjs", "export function total() { return 42; }\n");
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    }, /changed.*files/);
  },
);

test("project review permits local commits and amendments while rejecting premature tasks, acceptance, or publication", () => {
  const { root, env } = fixture();

  const before = prepare(root, resolve(import.meta.dirname, ".."), env, "project-review");
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  });
  write(
    root,
    "basket.mjs",
    "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
  );
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /continuation evidence/);
  const log =
    "---\nstatus: Approved\n---\n\n# TSK-0: Review basket totals\n\n## Review summary\n\nRepaired zero-quantity totals and removed duplicate discount paths. Developer review is pending.\n\n## Evidence and proposals\n\nVerified the README contract for empty, omitted, zero, and discounted quantities.\n\nProposed follow-up: group display and documentation improvements; developer has not accepted these tasks.\n";
  write(root, "workbench/tasks/TSK-00.md", log);
  workbench(root, env, "sync");
  verifyOutcome(root, env, "project-review", before);
  write(
    root,
    "workbench/tasks/TSK-01.md",
    "---\nstatus: Planned\nparent: fixture:TSK-0\n---\n\n# TSK-1: Unaccepted follow-up\n",
  );
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /follow-up tasks before developer review/);
  rmSync(join(root, "workbench/tasks/TSK-01.md"));
  write(root, "workbench/tasks/TSK-00.md", log.replace("status: Approved", "status: Accepted"));
  workbench(root, env, "sync");
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /pending developer checkpoint/);
  write(root, "workbench/tasks/TSK-00.md", log);
  workbench(root, env, "sync");
  command(root, env, "git", ["add", "."]);
  command(root, env, "git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Retain review evidence locally",
  ]);
  verifyOutcome(root, env, "project-review", before);
  command(root, env, "git", ["commit", "--amend", "--quiet", "-m", "Refine the unpublished review"]);
  verifyOutcome(root, env, "project-review", before);
  for (const ref of ["refs/heads/preview", "refs/tags/preview"]) {
    command(root, env, "git", ["push", "--quiet", "origin", `HEAD:${ref}`]);
    assert.throws(() => {
      verifyOutcome(root, env, "project-review", before);
    }, /published before developer acceptance/);
    command(root, env, "git", ["push", "--quiet", "origin", `:${ref}`]);
    verifyOutcome(root, env, "project-review", before);
  }
  command(root, env, "git", ["push", "--quiet", "origin", "main"]);
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /published before developer acceptance/);
});

test.each(Object.keys(rebaseCases) as (keyof typeof rebaseCases)[])(
  "%s evaluates real Git outcomes and rejects a broken resolution or refusal",
  (name) => {
    const { root, env } = fixture();
    const git = (...args: string[]) => command(root, env, "git", args);

    const before = prepare(root, resolve(import.meta.dirname, ".."), env, name);
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
