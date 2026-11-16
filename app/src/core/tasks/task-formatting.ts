import { relative } from "node:path";
import { readConfig } from "../projects/project-configuration.js";
import { formatWorkingRecords, ReviewFormatter, FormattingProblem } from "../review/review-formatting.js";
import { StateConflict } from "../runtime/input-errors.js";
import { readTaskGraph } from "./task-model.js";
import { readPlan } from "./planning/planning-store.js";
import { parsePlanReference } from "./planning/plan-model.js";
import { savePlanDraft } from "./planning/planning-operations.js";

/** Preparation changes layout, never approval, and rejects edits made after the selected version was captured. */
export async function prepareTaskReview(root: string, reference: string, expected: string): Promise<string> {
  if (reference.includes(":plan/")) {
    const identity = parsePlanReference(reference),
      plan = readPlan(root, identity);
    if (plan.digest !== expected) throw new StateConflict("Plan changed; refresh before reviewing");
    const formatted = await new ReviewFormatter().prepare(
      "plan.md",
      Buffer.from(plan.contents),
      readConfig(root).markdown?.wrap_width ?? 120,
    );
    if (formatted.state === "unavailable") throw new FormattingProblem(reference, formatted.problem);
    if (formatted.state === "changed") return savePlanDraft(root, identity, formatted.formatted, { expected }).digest;
    if (readPlan(root, identity).digest !== expected) throw new StateConflict("Plan changed while preparing review");
    return expected;
  }
  const task = readTaskGraph(root).require(reference);
  if (task.archived || expected !== (task.reviewDigest ?? task.digest))
    throw new StateConflict("Task changed; refresh before reviewing");
  const path = relative(root, task.path).replaceAll("\\", "/");
  await formatWorkingRecords(root, [path], new Map([[path, Buffer.from(task.contents)]]));
  const prepared = readTaskGraph(root).require(reference);
  return prepared.reviewDigest ?? prepared.digest;
}
