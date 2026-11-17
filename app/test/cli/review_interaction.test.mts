import { promised } from "../fixtures/promised.mjs";
import { required } from "../../src/core/runtime/invariants.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { registerTaskDecisionCommands } from "../../src/cli/task-decisions.js";
import { readTaskGraph, taskReference } from "../../src/core/tasks/task-model.js";
import { readTaskDecisions } from "../../src/core/tasks/task-decisions.js";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { reviewInteractively, reviewStatus } from "../../src/cli/review.js";
import { approveReview } from "../../src/core/review/review-approval.js";
import { checkReview } from "../../src/core/review/review-check.js";
import { reviewFixtures } from "../fixtures/review-interaction.mjs";
import { gitBytes } from "../../src/core/git/git-snapshot.ts";

const state = vi.hoisted(() => ({
  answers: [] as string[],
  question: vi.fn<(prompt: string) => Promise<string>>(),
  close: vi.fn(),
  terminal: true,
  documents: [] as string[],
}));

vi.mock("../../src/cli/terminal/terminal-choice.js", () => ({ terminalAvailable: () => state.terminal }));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: state.question, close: state.close, on: vi.fn() }),
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(
      (command: string, args: readonly string[] = [], options?: import("node:child_process").SpawnSyncOptions) => {
        if (options?.stdio !== "inherit") return actual.spawnSync(command, args, options);
        const result = actual.spawnSync(command, args, { encoding: "utf8" });
        state.documents.push(result.stdout);
        return result;
      },
    ),
  };
});

const fixture = reviewFixtures(state);

test("one task approval confirmation binds every selected version before recording any decisions", async () => {
  const { root } = fixture;
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/state"));
  const folder = join(root, "workbench/tasks"),
    second = join(folder, "TSK-01.md");
  mkdirSync(folder);
  writeFileSync(join(folder, "TSK-00.md"), "---\nstatus: Planned\n---\n\n# TSK-0: Review note paths\n");
  const plan = "---\nstatus: Planned\n---\n\n# TSK-1: Review note previews\n";
  writeFileSync(second, plan);
  const approve = () => {
    const cli = new Command(),
      tasks = cli.command("task");
    registerTaskDecisionCommands(tasks, root, (value) => taskReference(root, value));
    const versions = readTaskGraph(root).tasks.flatMap((task) => ["--expected", task.reviewDigest ?? task.digest]);
    return cli.parseAsync(["task", "approve", "test:TSK-0", "test:TSK-1", ...versions], { from: "user" });
  };
  state.question.mockImplementationOnce(() => {
    writeFileSync(second, plan + "\nAnother requirement appeared.\n");
    return Promise.resolve("yes");
  });
  await expect(approve()).rejects.toThrow(/TSK-1: changed since inspection/);
  expect(readTaskDecisions(root)).toEqual([]);
  expect(state.question).toHaveBeenCalledOnce();
  state.question.mockClear();
  state.answers = ["yes"];
  await approve();
  expect(state.question).toHaveBeenCalledOnce();
  expect(readTaskDecisions(root).map(({ reference, status }) => [reference, status])).toEqual([
    ["test:TSK-0", "Approved"],
    ["test:TSK-1", "Approved"],
  ]);
});

test.each(["", "no", "yes"])("interactive answer %j records only explicit approval", async (answer) => {
  state.answers = [answer];
  await reviewInteractively(fixture.root);
  if (answer === "yes")
    expect(() => {
      checkReview(fixture.root);
    }).not.toThrow();
  else
    expect(() => {
      checkReview(fixture.root);
    }).toThrow(/human review/);
  expect(state.close).toHaveBeenCalledOnce();
});

test.each(["no", "yes"])(
  "automatic formatting precedes content approval %s without staging the reflow",
  async (answer) => {
    const path = join(fixture.root, "workbench/decisions/ADR-00.md");
    const contents =
      "---\nsummary: A test-owned decision.\n---\n\n# ADR-0: Reviewed decision\n\n" +
      "A human-authored decision retains its meaning. ".repeat(8).trim() +
      "\n";
    writeFileSync(path, contents);
    fixture.git("add", ".");
    const staged = gitBytes(fixture.root, ["write-tree"]).toString();
    state.answers = [answer];
    await reviewInteractively(fixture.root);
    expect(gitBytes(fixture.root, ["write-tree"]).toString()).toBe(staged);
    expect(readFileSync(path, "utf8")).not.toBe(contents);
    expect(readFileSync(path, "utf8").split(/\s+/)).toEqual(contents.split(/\s+/));
    expect(state.question).toHaveBeenCalledOnce();
    expect(state.question.mock.calls[0]?.[0]).toContain("Approve these record changes");
    if (answer === "no") {
      expect(() => {
        checkReview(fixture.root);
      }).toThrow(/human review/);
    } else {
      expect(state.documents.at(-1)).toContain("A human-authored decision");
      // Only the formatted working version was acknowledged; the old staged bytes still need review.
      expect(() => {
        checkReview(fixture.root);
      }).toThrow(/human review/);
      fixture.git("add", ".");
      expect(() => {
        checkReview(fixture.root);
      }).not.toThrow();
    }
  },
);

test.each(["plain", "no-color"])("%s review suppresses diff color and keeps explicit approval", async (mode) => {
  vi.stubEnv("WORKBENCH_PLAIN", mode === "plain" ? "1" : "0");
  vi.stubEnv("NO_COLOR", mode === "no-color" ? "0" : "");
  state.answers = ["no"];
  await reviewInteractively(fixture.root);
  const call = vi.mocked(spawnSync).mock.calls.find(([, , options]) => options?.stdio === "inherit");
  expect(call?.[1]).toContain("--color=never");
  expect(call?.[1]).toContain(mode === "plain" ? "--no-pager" : "--paginate");
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
  expect(state.question).toHaveBeenCalledOnce();
});

test.each(["no", "yes"])("charter authorship requires separate confirmation: %s", async (authorship) => {
  writeFileSync(join(fixture.root, "workbench/CHARTER.md"), "Human intent.\n");
  fixture.git("add", ".");
  state.answers = ["yes", authorship];
  await reviewInteractively(fixture.root);
  if (authorship === "yes")
    expect(() => {
      checkReview(fixture.root);
    }).not.toThrow();
  else
    expect(() => {
      checkReview(fixture.root);
    }).toThrow(/human review/);
  expect(state.question).toHaveBeenCalledTimes(2);
});

test("changes staged during review leave the shown version acknowledged and the newer version pending", async () => {
  state.question.mockImplementationOnce(() =>
    promised(() => {
      writeFileSync(join(fixture.root, "workbench/decisions/ADR-00.md"), "Different decision.\n");
      fixture.git("add", ".");
      return "yes";
    }),
  );
  await reviewInteractively(fixture.root);
  expect(readFileSync(join(fixture.root, ".git/workbench/review.json"), "utf8")).toContain("contents");
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
  expect(state.close).toHaveBeenCalledOnce();
});

test("redirected input displays the diff without requesting or recording approval", async () => {
  state.terminal = false;
  await reviewInteractively(fixture.root);
  expect(state.question).not.toHaveBeenCalled();
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
});

test("an unchanged approval avoids another interactive diff and prompt", async () => {
  state.answers = ["yes"];
  await reviewInteractively(fixture.root);
  state.question.mockClear();
  state.documents = [];
  await reviewInteractively(fixture.root);
  expect(state.question).not.toHaveBeenCalled();
  expect(state.documents).toEqual([]);
  expect(() => {
    checkReview(fixture.root);
  }).not.toThrow();
});

test("approval covers a reduced selection but rejects new, modified, or damaged claims", () => {
  const extra = join(fixture.root, "workbench/decisions/ADR-01.md");
  writeFileSync(extra, "Additional reviewed policy.\n");
  fixture.git("add", ".");
  reviewStatus(fixture.root);
  const digest = required(
    /Review digest: ([a-f0-9]{64})/.exec(
      vi
        .mocked(console.log)
        .mock.calls.map(([value]) => String(value))
        .join("\n"),
    ),
    "Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(vi.mocked(console.log).mock.calls.map(([value]) => String(value)).join(",
  )[1];
  approveReview(fixture.root, required(digest, "Expected fixture value"), false);
  const receipt = join(fixture.root, ".git/workbench/review.json");
  const approved = readFileSync(receipt, "utf8");
  fixture.git("rm", "--cached", "workbench/decisions/ADR-01.md");
  expect(() => {
    checkReview(fixture.root);
  }).not.toThrow();
  expect(readFileSync(receipt, "utf8")).toBe(approved);
  const changed = join(fixture.root, "workbench/decisions/ADR-00.md");
  writeFileSync(changed, "Different policy.\n");
  fixture.git("add", changed);
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
  writeFileSync(changed, "# Reviewed decision\n");
  fixture.git("add", changed);
  fixture.git("add", extra);
  writeFileSync(extra, "Unreviewed addition.\n");
  fixture.git("add", extra);
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
  fixture.git("rm", "--cached", "workbench/decisions/ADR-01.md");
  const damaged = JSON.parse(approved) as { changes: { after: string }[] };
  required(damaged.changes[0], "Expected fixture value").after = "invented";
  writeFileSync(receipt, JSON.stringify(damaged));
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
});

test("the first commit can review an immutable tree without an existing HEAD", async () => {
  fixture.git("symbolic-ref", "HEAD", "refs/heads/first-commit");
  state.answers = ["yes", "yes"];
  await reviewInteractively(fixture.root);
  expect(state.documents.join("\n")).toContain("Reviewed decision");
  expect(() => {
    checkReview(fixture.root);
  }).not.toThrow();
});
