import { InvalidInput } from "../../runtime/input-errors.js";
import { record, records, string } from "../../runtime/values.mjs";
import { decodeQueue, type TaskQueue } from "../task-queue-state.js";
import { decodeTaskDecisionChange, type TaskDecisionChange } from "../task-decision-state.js";
import { parsePlanReference, safePlanFile } from "./plan-model.js";

export interface TransferPlan {
  reference: string;
  tree: string;
  task: string;
  path: string;
  planDigest: string;
}
export interface TransferData {
  plans: TransferPlan[];
  files: { path: string; mode: string; oid: string }[];
  before: TaskQueue;
  after: TaskQueue;
  decisions: TaskDecisionChange[];
  sourceHead?: string;
}
export interface RenameData {
  before: string;
  after: string;
  changes: { reference: string; expected?: string; content?: string }[];
}
export const objectId = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function decodeTransferData(input: unknown): TransferData {
  const value = record(input, "Invalid transfer payload");
  const plans = records(value.plans, "Invalid transferred plans").map((plan): TransferPlan => {
    const reference = string(plan.reference, "Missing transferred plan"),
      task = string(plan.task, "Missing implementation task"),
      path = string(plan.path, "Missing implementation path"),
      tree = string(plan.tree, "Missing captured plan tree"),
      planDigest = string(plan.planDigest, "Missing implementation plan digest");
    if (
      !new RegExp(`^${parsePlanReference(reference).scope}:TSK-[0-9A-Z]+$`).test(task) ||
      !safePlanFile(path) ||
      !objectId(tree) ||
      !/^[a-f0-9]{64}$/.test(planDigest)
    )
      throw new InvalidInput("Invalid planning transfer identity");
    return { reference, task, path, tree, planDigest };
  });
  if (
    !plans.length ||
    new Set(plans.map((plan) => plan.reference)).size !== plans.length ||
    new Set(plans.map((plan) => plan.task)).size !== plans.length
  )
    throw new InvalidInput("Duplicate or missing transferred plans");
  const files = records(value.files, "Invalid implementation files").map((file) => {
    const path = string(file.path, "Missing implementation file"),
      oid = string(file.oid, "Missing implementation object"),
      mode = string(file.mode, "Missing implementation mode");
    if (
      !safePlanFile(path) ||
      !objectId(oid) ||
      !["100644", "100755"].includes(mode) ||
      !plans.some((plan) => path === plan.path || path.startsWith(plan.path.slice(0, -3) + "/"))
    )
      throw new InvalidInput("Invalid implementation recovery file");
    return { path, oid, mode };
  });
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    plans.some((plan) => !files.some((file) => file.path === plan.path))
  )
    throw new InvalidInput("Incomplete implementation recovery files");
  const sourceHead =
    value.sourceHead === undefined ? undefined : string(value.sourceHead, "Invalid implementation baseline");
  if (sourceHead !== undefined && !objectId(sourceHead)) throw new InvalidInput("Invalid implementation baseline");
  return {
    plans,
    files,
    before: decodeQueue(value.before),
    after: decodeQueue(value.after),
    decisions: records(value.decisions, "Invalid transferred decisions").map(decodeTaskDecisionChange),
    ...(sourceHead ? { sourceHead } : {}),
  };
}
export function decodeRenameData(input: unknown): RenameData {
  const value = record(input, "Invalid rename payload"),
    before = parsePlanReference(string(value.before, "Missing previous plan name")),
    after = parsePlanReference(string(value.after, "Missing new plan name"));
  if (before.scope !== after.scope || before.reference === after.reference)
    throw new InvalidInput("Invalid renamed plan identity");
  const changes = records(value.changes, "Missing rename contents").map((change, index) => {
    const reference = parsePlanReference(string(change.reference, "Missing renamed plan")).reference,
      expected = change.expected === undefined ? undefined : string(change.expected, "Missing previous plan version"),
      content = change.content === undefined ? undefined : string(change.content, "Invalid renamed contents");
    if (
      (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) ||
      (content !== undefined && content !== `changes/${String(index)}/`)
    )
      throw new InvalidInput("Invalid rename recovery version or content");
    return { reference, ...(expected ? { expected } : {}), ...(content ? { content } : {}) };
  });
  if (
    !changes.some((change) => change.reference === before.reference && !change.content) ||
    !changes.some((change) => change.reference === after.reference && change.content) ||
    new Set(changes.map((change) => change.reference)).size !== changes.length
  )
    throw new InvalidInput("Incomplete rename recovery");
  return { before: before.reference, after: after.reference, changes };
}
