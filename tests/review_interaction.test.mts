import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { reviewInteractively, checkReview, approveReview, reviewStatus } from "../src/review.ts";
import { reviewFixtures } from "./fixtures/review-interaction.mjs";

const state = vi.hoisted(() => ({
  answers: [] as string[],
  question: vi.fn<(prompt: string) => Promise<string>>(),
  close: vi.fn(),
  terminal: true,
  documents: [] as string[],
}));

vi.mock("../src/terminal-choice.js", () => ({ terminalAvailable: () => state.terminal }));

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

test("changes staged during review invalidate the displayed diff", async () => {
  state.question.mockImplementationOnce(() =>
    promised(() => {
      writeFileSync(join(fixture.root, "workbench/decisions/ADR-00.md"), "Different decision.\n");
      fixture.git("add", ".");
      return "yes";
    }),
  );
  await expect(reviewInteractively(fixture.root)).rejects.toThrow(/digest changed/);
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
