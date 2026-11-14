import { normalizedNumber } from "../../records/record-identity.js";
import { createHash } from "node:crypto";
import {
  parseProseRecord,
  editRecordMetadata,
  recordTimestamp,
  type MetadataByKind,
} from "../../records/record-document.js";
import type { GitEntry } from "../../git/git-snapshot.js";
import { InvalidInput } from "../../runtime/input-errors.js";
import { isRecord } from "../../runtime/values.mjs";

export interface PlanIdentity {
  scope: string;
  name: string;
  reference: string;
}
export interface PlanDocument {
  title: string;
  metadata: MetadataByKind["TSK"];
  body: string;
}
export function planIdentity(scope: string, name: string): PlanIdentity {
  if (!/^[a-z][a-z0-9_-]*$/.test(scope) || !/^[a-z][a-z0-9_-]{0,119}$/.test(name))
    throw new InvalidInput(
      "Use a project scope and a lowercase plan name containing letters, digits, underscores, or hyphens",
    );
  return { scope, name, reference: `${scope}:plan/${name}` };
}
export function parsePlanReference(value: string): PlanIdentity {
  const match = /^([^:]+):plan\/(.+)$/.exec(value);
  if (!match?.[1] || !match[2])
    throw new InvalidInput("Expected a scoped plan reference, such as project:plan/service");
  return planIdentity(match[1], match[2]);
}
export function normalizedWorkReference(value: string): string {
  const task = /^([a-z][a-z0-9_-]*):[Tt][Ss][Kk]-([0-9A-Za-z]+)$/.exec(value);
  if (task?.[1] && task[2]) return `${task[1]}:TSK-${normalizedNumber(task[2])}`;
  return parsePlanReference(value).reference;
}
export function workReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    normalizedWorkReference(value);
    return true;
  } catch {
    return false;
  }
}
export function parsePlan(contents: string, reference: string): PlanDocument {
  const { metadata, body } = parseProseRecord(contents, reference);
  if (Object.keys(metadata).some((key) => !["status", "parent", "depends_on", "added_at", "extensions"].includes(key)))
    throw new InvalidInput(`${reference}: unknown plan metadata; custom fields belong in extensions`);
  if (!["Planned", "Approved", "Canceled"].includes(String(metadata.status)))
    throw new InvalidInput(`${reference}: a future plan must be Planned, Approved, or Canceled`);
  if (metadata.parent !== undefined && metadata.parent !== null && !workReference(metadata.parent))
    throw new InvalidInput(`${reference}: invalid parent`);
  if (
    metadata.depends_on !== undefined &&
    (!Array.isArray(metadata.depends_on) ||
      !metadata.depends_on.every(workReference) ||
      new Set(metadata.depends_on).size !== metadata.depends_on.length)
  )
    throw new InvalidInput(`${reference}: dependencies must be distinct scoped task or plan references`);
  if (typeof metadata.parent === "string") metadata.parent = normalizedWorkReference(metadata.parent);
  if (Array.isArray(metadata.depends_on)) {
    const dependencies = metadata.depends_on.map((value) => normalizedWorkReference(value));
    if (new Set(dependencies).size !== dependencies.length)
      throw new InvalidInput(`${reference}: dependencies must be distinct`);
    metadata.depends_on = dependencies;
  }
  if (metadata.extensions !== undefined && !isRecord(metadata.extensions))
    throw new InvalidInput(`${reference}: extensions must be a mapping`);
  if (metadata.added_at !== undefined && !recordTimestamp(metadata.added_at))
    throw new InvalidInput(`${reference}: added_at must be a UTC ISO timestamp`);
  const title = /^# ([^\r\n]+)(?:\r?\n|$)/.exec(body)?.[1]?.trim();
  if (!title) throw new InvalidInput(`${reference}: begin the plan with a nonempty level-one title`);
  return { title, metadata: metadata as MetadataByKind["TSK"], body };
}
/** Bookkeeping survives ordinary edits; incomplete drafts remain editable verbatim. */
export function withPlanAddedAt(contents: string, previous?: string): string {
  let metadata: Record<string, unknown>;
  try {
    metadata = parseProseRecord(contents, "plan").metadata;
  } catch {
    return contents;
  }
  let added: unknown;
  if (previous) {
    try {
      added = parseProseRecord(previous, "previous plan").metadata.added_at;
    } catch {
      /* Incomplete draft. */
    }
  }
  if (recordTimestamp(added))
    return metadata.added_at === added ? contents : editRecordMetadata(contents, { added_at: added });
  return metadata.added_at === undefined
    ? editRecordMetadata(contents, { added_at: new Date().toISOString() })
    : contents;
}
export function safePlanFile(path: string): boolean {
  return (
    !/[\0\r\n\\:]/.test(path) &&
    path.split("/").every((part) => !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  );
}
export function planContent(entries: ReadonlyMap<string, GitEntry>): Map<string, GitEntry> {
  return new Map(
    [...entries].filter(([path]) => path === planningPaths.document || path.startsWith(planningPaths.files)),
  );
}
export const planStateVersion = (tree: string, branchTree?: string, baseTree?: string): string =>
  createHash("sha256")
    .update(JSON.stringify([tree, branchTree ?? null, baseTree ?? null]))
    .digest("hex");
export function planVersion(entries: ReadonlyMap<string, GitEntry>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...entries]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([path, entry]) => [path, entry.mode, entry.oid]),
      ),
    )
    .digest("hex");
}
export const planningPaths = {
  settings: "planning.toml",
  operation: "planning-operation.json",
  operations: "refs/workbench/plan-operations/",
  drafts: "refs/workbench/plan-drafts/",
  bases: "refs/workbench/plan-draft-bases/",
  removals: "refs/workbench/plan-removals/",
  groups: "refs/workbench/plan-draft-groups",
  scopes: ".workbench/scopes.json",
  records: "plans/",
  document: "plan.md",
  files: "files/",
  approved: ".approved/",
  approval: ".approval.json",
  checkpoints: "refs/workbench/plan-checkpoints/",
} as const;
export const planPrefix = (identity: PlanIdentity): string =>
  `${planningPaths.records}${identity.scope}/${identity.name}/`;
export const planDraftRef = (identity: PlanIdentity): string =>
  planningPaths.drafts + identity.scope + "/" + identity.name;
export const planBaseRef = (identity: PlanIdentity): string =>
  planningPaths.bases + identity.scope + "/" + identity.name;

export const planRemovalRef = (identity: PlanIdentity): string =>
  planningPaths.removals + identity.scope + "/" + identity.name;
