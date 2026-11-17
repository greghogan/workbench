import { expect, test } from "vitest";
import { appendTaskAccount, taskPlanApprovalDigest, taskPlanDigest } from "../../../src/core/tasks/task-plan.ts";
import { formatDocument } from "../../../src/core/records/formatting.ts";

const record = (body: string) => `---\nstatus: Approved\n---\n\n# TSK-0: Service installation\n\n${body}\n`;

test("plan approval survives canonical formatting at different widths while verification keeps its exact source binding", async () => {
  const original = record(
    "## Overview\n\n" +
      "Preserve user work while installing and restarting the service. ".repeat(8) +
      "\n\n- [ ] Keep existing data.\n\n- [ ] Verify recovery.\n\n```sh\n  keep  literal  spacing\n```\n",
  );
  const digest = taskPlanApprovalDigest(original);
  for (const width of [60, 120]) {
    const formatted = await formatDocument(original, "TSK-00.md", width);
    expect(formatted).not.toBe(original);
    expect(taskPlanApprovalDigest(formatted)).toBe(digest);
    expect(taskPlanDigest(formatted)).not.toBe(taskPlanDigest(original));
  }
  const tight = record("- [ ] Keep existing data.\n- [ ] Verify recovery.\n");
  expect(taskPlanApprovalDigest(tight)).toBe(
    taskPlanApprovalDigest(tight.replace("\n- [ ] Verify", "\n\n- [ ] Verify")),
  );
});

test.each([
  ["wording", "Preserve all data.", "Preserve some data."],
  ["link destination", "Read [requirements](one.md).", "Read [requirements](two.md)."],
  ["paragraph boundary", "First requirement.\nSecond requirement.", "First requirement.\n\nSecond requirement."],
  ["deliberate line break", "First requirement.\nSecond requirement.", "First requirement.  \nSecond requirement."],
  ["list hierarchy", "- First requirement\n  - Second requirement", "- First requirement\n- Second requirement"],
  ["inline code", "Keep `two  spaces`.", "Keep `two spaces`."],
  ["fenced evidence", "```sh\n  keep  spacing\n```", "```sh\n  keep spacing\n```"],
  ["fence attributes", "```sh target=one\nkeep spacing\n```", "```sh target=two\nkeep spacing\n```"],
])("plan approval detects changed %s", (_name, before, after) => {
  expect(taskPlanApprovalDigest(record(before))).not.toBe(taskPlanApprovalDigest(record(after)));
});

test("execution accounts cannot conceal later plan sections, and supporting files stay exact", () => {
  const original = record(
    "## Overview\n\nPreserve all data.\n\n- [ ] Verify recovery.\n\n## Implementation account\n\nInvestigating.\n\n## Constraints\n\nUse local storage.",
  );
  const progress = original.replace("[ ]", "[x]").replace("Investigating.", "Recovery is verified.");
  expect(taskPlanApprovalDigest(progress)).toBe(taskPlanApprovalDigest(original));
  expect(taskPlanApprovalDigest(progress.replace("local storage", "remote storage"))).not.toBe(
    taskPlanApprovalDigest(original),
  );
  const file = { name: "requirements.txt", contents: Buffer.from("one\n").toString("base64"), executable: false },
    files = [file];
  expect(taskPlanApprovalDigest(original, files)).not.toBe(
    taskPlanApprovalDigest(original, [{ ...file, contents: Buffer.from("two\n").toString("base64") }]),
  );
  expect(taskPlanApprovalDigest(original, files)).not.toBe(
    taskPlanApprovalDigest(original, [{ ...file, executable: true }]),
  );
});

test("generated implementation accounts precede agent detail and preserve approved plan identity", () => {
  const original = record(
    "## Review summary\n\nPreserve all data.\n\n## Implementing-agent detail\n\n### Verification\n\nExercise recovery.",
  );
  const delivered = appendTaskAccount(original, "Verified recovery with existing data.");
  expect(delivered).toBe(
    original.replace(
      "## Implementing-agent detail",
      "## Implementation account\n\nVerified recovery with existing data.\n\n## Implementing-agent detail",
    ),
  );
  expect(taskPlanApprovalDigest(delivered)).toBe(taskPlanApprovalDigest(original));
  expect(taskPlanDigest(delivered)).toBe(taskPlanDigest(original));
  expect(taskPlanApprovalDigest(delivered.replace("## Implementation account", "### Implementation account"))).toBe(
    taskPlanApprovalDigest(original),
  );
});
