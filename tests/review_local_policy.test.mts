import { required } from "../src/invariants.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { reviewInteractively, checkReview } from "../src/review.ts";
import { git as fixtureGit } from "./fixtures/adoption.mjs";
import { policyCompatibility, acknowledgePolicyCompatibility } from "../src/policy-compatibility.ts";
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

test.each(["yes", "no"])("record approval is independent of compatibility acknowledgment: %s", async (answer) => {
  const { receipt } = await fixture.localFixture();
  state.answers = [answer];
  await reviewInteractively(fixture.root);
  expect(state.question).toHaveBeenCalledOnce();
  expect(required(state.question.mock.calls[0], "Expected fixture value: state.question.mock.calls[0]")[0]).toBe(
    "Approve these staged record changes? [y/N] ",
  );
  expect(state.documents).toHaveLength(1);
  expect(state.documents[0]).toContain("Use the scheduler.");
  expect(state.documents[0]).not.toContain("Use the installed scheduler for substantial work.");
  if (answer === "yes")
    expect(() => {
      checkReview(fixture.root);
    }).not.toThrow();
  else
    expect(() => {
      checkReview(fixture.root);
    }).toThrow(/human review/);
  expect(existsSync(receipt)).toBe(false);
  expect(policyCompatibility(fixture.root).status).toBe("review-required");
});

test("charter authorship refusal records no approval or compatibility acknowledgment", async () => {
  const { receipt } = await fixture.localFixture();
  writeFileSync(join(fixture.root, "workbench/CHARTER.md"), "Changed human intent.\n");
  fixture.git("add", ".");
  state.answers = ["yes", "no"];
  await reviewInteractively(fixture.root);
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
  expect(existsSync(receipt)).toBe(false);
});

test("stale compatibility alone does not open a human record review", async () => {
  const { receipt } = await fixture.localFixture();
  fixtureGit(fixture.root, "commit", "-qm", "Project policy");
  await reviewInteractively(fixture.root);
  expect(state.question).not.toHaveBeenCalled();
  expect(state.documents).toHaveLength(0);
  expect(existsSync(receipt)).toBe(false);
  expect(policyCompatibility(fixture.root).status).toBe("review-required");
});

test("partial staging displays and approves only staged record changes", async () => {
  const { decision, receipt } = await fixture.localFixture();
  writeFileSync(decision, readFileSync(decision, "utf8").replace("Use the scheduler.", "Unstaged policy."));
  state.answers = ["yes"];
  await reviewInteractively(fixture.root);
  expect(state.documents).toHaveLength(1);
  expect(state.documents[0]).toContain("Use the scheduler.");
  expect(state.documents[0]).not.toContain("Unstaged policy.");
  expect(existsSync(receipt)).toBe(false);
  expect(() => {
    checkReview(fixture.root);
  }).not.toThrow();
});

test.each(["collision", "stale context"])("record approval does not resolve compatibility %s", async (kind) => {
  const { base, receipt } = await fixture.localFixture();
  if (kind === "collision") {
    const path = join(fixture.root, "workbench/projects.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace('id = "demo"', 'id = "machine"'));
    fixture.git("add", path);
  } else writeFileSync(join(base, "AGENTS.md"), "Stale context.\n");
  state.answers = ["yes"];
  await reviewInteractively(fixture.root);
  expect(state.question).toHaveBeenCalledOnce();
  expect(existsSync(receipt)).toBe(false);
  expect(() => {
    checkReview(fixture.root);
  }).not.toThrow();
  expect(policyCompatibility(fixture.root).status).toBe(kind === "collision" ? "conflict" : "stale-context");
});

test("redirected record review omits unchanged local policies and records no acknowledgment", async () => {
  const { receipt } = await fixture.localFixture();
  state.terminal = false;
  await reviewInteractively(fixture.root);
  expect(state.question).not.toHaveBeenCalled();
  const output = fixture.stdoutWrite.mock.calls.map(([text]) => text).join("");
  expect(output).toContain("Use the scheduler.");
  expect(output).not.toContain("Use the installed scheduler for substantial work.");
  expect(existsSync(receipt)).toBe(false);
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
});

test("record approval preserves an existing compatibility acknowledgment", async () => {
  const { receipt } = await fixture.localFixture();
  acknowledgePolicyCompatibility(fixture.root, policyCompatibility(fixture.root).digest, true);
  const before = readFileSync(receipt);
  state.answers = ["yes"];
  await reviewInteractively(fixture.root);
  expect(state.question).toHaveBeenCalledOnce();
  expect(required(state.question.mock.calls[0], "Expected fixture value: state.question.mock.calls[0]")[0]).toBe(
    "Approve these staged record changes? [y/N] ",
  );
  expect(state.documents).toHaveLength(1);
  expect(readFileSync(receipt)).toEqual(before);
  expect(() => {
    checkReview(fixture.root);
  }).not.toThrow();
});

test("interrupted record confirmation records no approval or compatibility acknowledgment", async () => {
  const { receipt } = await fixture.localFixture();
  state.question.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
  await expect(reviewInteractively(fixture.root)).rejects.toThrow(/Canceled/);
  expect(state.close).toHaveBeenCalledOnce();
  expect(existsSync(receipt)).toBe(false);
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
});
