import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { checkReview } from "../src/review.ts";
import { distribution } from "./fixtures/adoption.mjs";
import { approveLocalPolicy, reviewLocalPolicy } from "../src/local-policy.ts";
import { policyCompatibility } from "../src/policy-compatibility.ts";
import { withStagedPolicyReview } from "../src/review-policy.ts";
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

test.each(["project", "decision", "local"])(
  "compatibility acknowledgment rejects policies changed since inspection: %s",
  async (kind) => {
    const { base, receipt } = await fixture.localFixture();
    await expect(
      withStagedPolicyReview(fixture.root, (review) =>
        promised(() => {
          if (kind === "project") {
            const path = join(fixture.root, "workbench/projects.toml");
            writeFileSync(path, readFileSync(path, "utf8").replace('id = "demo"', 'id = "renamed"'));
            fixture.git("add", path);
          } else if (kind === "decision") {
            const path = join(fixture.root, "workbench/decisions/ADR-00.md");
            writeFileSync(path, readFileSync(path, "utf8").replace("Use the scheduler.", "Changed policy."));
            fixture.git("add", path);
          } else {
            const draft = join(base, ".drafts/machine/workbench/decisions/ADR-00.md");
            writeFileSync(draft, readFileSync(draft, "utf8").replace("substantial work", "all builds"));
            approveLocalPolicy(base, "machine", reviewLocalPolicy(base, "machine").digest, true);
          }
          review.acknowledge(review.status.digest, true);
        }),
      ),
    ).rejects.toThrow(/changed during review/);
    expect(existsSync(receipt)).toBe(false);
    expect(() => {
      checkReview(fixture.root);
    }).toThrow(/human review/);
  },
);

test("compatibility status exposes checkout paths and excludes independent exports", async () => {
  await fixture.localFixture();
  const exported = join(fixture.root, "exports/company/workbench/decisions/ADR-00.md");
  mkdirSync(join(exported, ".."), { recursive: true });
  writeFileSync(exported, "Not project policy.\n");
  fixture.git("add", ".");
  await withStagedPolicyReview(fixture.root, (review) => {
    expect(review.status.project).toBe(policyCompatibility(fixture.root).project);
    expect(review.status.project_sources).toEqual([
      { id: "demo", scopes: ["."], decision_map: join(fixture.root, "workbench/decision-map.md") },
    ]);
    expect(Object.hasOwn(review, "directory")).toBe(false);
  });
});

test("unrelated code and configuration staging do not invalidate compatibility review", async () => {
  const { receipt } = await fixture.localFixture();
  await withStagedPolicyReview(fixture.root, (review) => {
    writeFileSync(join(fixture.root, "implementation.txt"), "Unrelated code.\n");
    const path = join(fixture.root, "workbench/config.toml");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n# Unrelated formatting\n`);
    fixture.git("add", ".");
    review.acknowledge(review.status.digest, true);
    review.check();
  });
  expect((JSON.parse(readFileSync(receipt, "utf8")) as { digest: string }).digest).toBe(
    policyCompatibility(fixture.root).digest,
  );
});

test("the CLI acknowledges reviewed staged policies independently of unstaged policy and human approval", async () => {
  const { decision, receipt } = await fixture.localFixture();
  const stagedProject = policyCompatibility(fixture.root).project;
  writeFileSync(decision, readFileSync(decision, "utf8").replace("Use the scheduler.", "Unstaged policy."));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), "collection", "compatibility", ...args], {
      cwd: fixture.root,
      encoding: "utf8",
    });
  const inspection = run("--staged");
  expect(inspection.status, inspection.stderr).toBe(0);
  const status = JSON.parse(inspection.stdout) as {
    project: string;
    selection: string;
    digest: string;
    project_sources: { decision_map: string }[];
  };
  expect(status.project).toBe(stagedProject);
  expect(status.selection).toBe("staged");
  expect(required(status.project_sources[0], "Expected fixture value").decision_map).toBe(
    join(fixture.root, "workbench/decision-map.md"),
  );
  expect(run("acknowledge", "--staged", "--digest", status.digest).status).not.toBe(0);
  expect(existsSync(receipt)).toBe(false);
  const acknowledgment = run("acknowledge", "--staged", "--digest", status.digest, "--reviewed");
  expect(acknowledgment.status, acknowledgment.stderr).toBe(0);
  expect((JSON.parse(readFileSync(receipt, "utf8")) as { project: string }).project).toBe(stagedProject);
  expect(policyCompatibility(fixture.root).status).toBe("review-required");
  expect(run("check", "--staged").status).toBe(0);
  expect(run("--staged", "check").status).toBe(0);
  expect(run("check").status).not.toBe(0);
  await withStagedPolicyReview(fixture.root, (review) =>
    promised(() => {
      expect(review.status.status).toBe("current");
    }),
  );
  expect(() => {
    checkReview(fixture.root);
  }).toThrow(/human review/);
});

test.each([false, true])("staged compatibility snapshots are removed after callback failure %s", async (fail) => {
  await fixture.localFixture();
  const scratch = join(fixture.root, ".git", "policy-scratch");
  mkdirSync(scratch);
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, scratch);
  const run = () =>
    withStagedPolicyReview(fixture.root, () => {
      expect(readdirSync(scratch)).toHaveLength(1);
      if (fail) throw new Error("review interrupted");
    });
  if (fail) await expect(run()).rejects.toThrow("review interrupted");
  else await run();
  expect(readdirSync(scratch)).toEqual([]);
});
