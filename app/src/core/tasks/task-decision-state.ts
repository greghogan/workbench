import { record, records, string } from "../runtime/values.mjs";
import { InvalidInput } from "../runtime/input-errors.js";
export interface TaskDecision {
  reference: string;
  status: "Approved" | "Accepted";
  digest: string;
  updated: string;
  tree?: string;
  outcome?: string;
  snapshot?: string;
  source?: "developer-requested-review";
}
export interface TaskDecisionState {
  reference: string;
  revision: number;
  decisions: TaskDecision[];
}
export interface TaskDecisionChange {
  reference: string;
  revision: number;
  before: TaskDecision[];
  after: TaskDecision[];
}

function decodeTaskDecisions(input: unknown): TaskDecision[] {
  const decisions = records(input, "Invalid task decisions").map((value): TaskDecision => {
    if (
      Object.keys(value).some(
        (key) => !["reference", "status", "digest", "updated", "tree", "outcome", "snapshot", "source"].includes(key),
      )
    )
      throw new InvalidInput("Unknown human task decision field");
    const reference = decodeTaskReference(value.reference),
      status = decodeDecisionStatus(value.status),
      digest = string(value.digest, "Missing decision digest"),
      updated = string(value.updated, "Missing decision time");
    if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isFinite(Date.parse(updated)))
      throw new InvalidInput("Invalid human task decision");
    const tree = value.tree === undefined ? undefined : string(value.tree, "Invalid accepted tree");
    if (tree !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))
      throw new InvalidInput("Invalid accepted snapshot");
    const outcome = value.outcome === undefined ? undefined : string(value.outcome, "Invalid accepted outcome");
    if (outcome !== undefined && (status !== "Accepted" || !/^[a-f0-9]{64}$/.test(outcome)))
      throw new InvalidInput("Invalid accepted outcome");
    const snapshot = value.snapshot === undefined ? undefined : string(value.snapshot, "Invalid plan snapshot");
    if (snapshot !== undefined && !/^[a-f0-9]{64}$/.test(snapshot))
      throw new InvalidInput("Invalid approved plan snapshot");
    const source = value.source;
    if (source !== undefined && (source !== "developer-requested-review" || status !== "Approved" || !snapshot))
      throw new InvalidInput("Invalid project review authorization");
    return {
      reference,
      status,
      digest,
      updated,
      ...(tree ? { tree } : {}),
      ...(outcome ? { outcome } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(source ? { source } : {}),
    };
  });
  if (decisions.length > 20000 || new Set(decisions.map(decisionIdentity)).size !== decisions.length)
    throw new InvalidInput("Duplicate or excessive human task decisions");
  return decisions;
}

export function decisionIdentity(decision: TaskDecision): string {
  return JSON.stringify([
    decision.reference,
    decision.status,
    decision.digest,
    decision.outcome ?? decision.tree ?? null,
  ]);
}

function decodeTaskReference(input: unknown): string {
  const reference = string(input, "Missing decided task");
  if (!/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(reference)) throw new InvalidInput("Invalid decided task reference");
  return reference;
}

function decodeDecisionStatus(input: unknown): TaskDecision["status"] {
  if (input !== "Approved" && input !== "Accepted") throw new InvalidInput("Invalid human task decision status");
  return input;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
}
export function decodeState(input: unknown): TaskDecisionState {
  const data = record(input, "Invalid task decision state"),
    reference = decodeTaskReference(data.reference),
    decisions = decodeTaskDecisions(data.decisions);
  if (
    !validRevision(data.revision) ||
    decisions.some((decision) => decision.reference !== reference) ||
    Object.keys(data).some((key) => !["reference", "revision", "decisions"].includes(key))
  )
    throw new InvalidInput("Invalid task decision state");
  return { reference, revision: data.revision, decisions };
}
export function decodeTaskDecisionChange(input: unknown): TaskDecisionChange {
  const data = record(input, "Invalid task decision change"),
    reference = decodeTaskReference(data.reference),
    before = decodeTaskDecisions(data.before),
    after = decodeTaskDecisions(data.after);
  if (
    !validRevision(data.revision) ||
    Object.keys(data).some((key) => !["reference", "revision", "before", "after"].includes(key)) ||
    [...before, ...after].some((decision) => decision.reference !== reference)
  )
    throw new InvalidInput("Invalid task decision change");
  return { reference, revision: data.revision, before, after };
}
