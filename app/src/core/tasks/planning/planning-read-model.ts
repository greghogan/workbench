import type { BrowserRecord } from "../../records/record-service.js";
import { markdownExcerpt } from "../../records/markdown-excerpt.js";
import type { TaskStatus } from "../../records/record-document.js";
import { planningPaths, planPrefix } from "./plan-model.js";
import { readPlans, type PlanView } from "./planning-store.js";
import { planClaims, type PlanClaim } from "./plan-operation-store.js";

export interface PlanningRecord {
  reference: string;
  scope: string;
  name: string;
  title: string;
  summary: string;
  contents: string;
  digest: string;
  status: TaskStatus;
  parent?: string;
  dependencies: string[];
  problem?: string;
  draft: boolean;
  conflict: boolean;
  implementation?: { task: string; checkout: string; pending: boolean };
  approval?: { at: string; contents: string; current: boolean };
  files: { name: string; executable: boolean; oid: string }[];
  changedFiles: { name: string; change: "added" | "changed" | "removed" }[];
}
export function planningRecord(view: PlanView, claim?: PlanClaim): PlanningRecord {
  const files = [...view.entries]
    .filter(([path]) => path.startsWith(planningPaths.files))
    .map(([path, entry]) => ({
      name: path.slice(planningPaths.files.length),
      executable: entry.mode === "100755",
      oid: entry.oid,
    }));
  const previous = new Map(
    [...(view.approval?.entries ?? [])]
      .filter(([path]) => path.startsWith(planningPaths.files))
      .map(([path, entry]) => [path.slice(planningPaths.files.length), entry]),
  );
  const current = new Map(files.map((file) => [file.name, file]));
  const changedFiles = [...new Set([...previous.keys(), ...current.keys()])]
    .sort()
    .flatMap((name): PlanningRecord["changedFiles"] => {
      const before = previous.get(name),
        after = current.get(name);
      if (!before) return [{ name, change: "added" }];
      if (!after) return [{ name, change: "removed" }];
      return before.oid !== after.oid || (before.mode === "100755") !== after.executable
        ? [{ name, change: "changed" }]
        : [];
    });
  return {
    ...(claim
      ? {
          implementation: {
            task: claim.task,
            checkout: claim.operation.operation.checkout,
            pending: !claim.operation.operation.completed,
          },
        }
      : {}),
    reference: view.reference,
    scope: view.scope,
    name: view.name,
    title: view.document?.title ?? view.name,
    summary: markdownExcerpt(view.document?.body ?? ""),
    contents: view.contents,
    digest: view.digest,
    status: view.document?.metadata.status ?? "Planned",
    ...(view.document?.metadata.parent ? { parent: view.document.metadata.parent } : {}),
    dependencies: view.document?.metadata.depends_on ?? [],
    ...(view.problem ? { problem: view.problem } : {}),
    draft: view.draft,
    conflict: view.conflict,
    ...(view.approval
      ? { approval: { at: view.approval.at, contents: view.approval.contents, current: view.approval.current } }
      : {}),
    files,
    changedFiles,
  };
}

export function readPlanningRecords(root: string): PlanningRecord[] {
  const claims = new Map(planClaims(root).map((claim) => [claim.reference, claim]));
  return readPlans(root).map((view) => planningRecord(view, claims.get(view.reference)));
}

export function planningBrowserRecord(root: string, plan: PlanningRecord, status = plan.status): BrowserRecord {
  return {
    id: plan.reference,
    type: "TSK",
    scope: plan.scope,
    title: plan.title,
    summary: plan.summary,
    status,
    path: planPrefix(plan) + planningPaths.document,
    directory: root,
    editable: true,
    local: false,
    collection: false,
    ...(plan.problem ? { previewError: plan.problem } : {}),
  };
}
