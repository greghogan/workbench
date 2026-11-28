import type { BrowserRecord } from "../../core/records/record-service.js";
import type { ReviewGroup, WorkspaceView } from "../workspace/workspace-service.js";
import { reviewCollection } from "./review-queue.js";

type CommitUnit = WorkspaceView["standaloneCommitReviews"][number];
type CommitGroup = CommitUnit["groups"][number];
export type ReviewRow =
  | { kind: "task"; id: string; record: BrowserRecord }
  | { kind: "working"; id: string; group: ReviewGroup }
  | { kind: "commit"; id: string; group: CommitGroup; commit: string; task?: string };

interface ReviewPanel {
  id: string;
  task?: BrowserRecord;
  commit?: Pick<CommitUnit, "revision" | "subject">;
  rows: ReviewRow[];
}

export interface ReviewScope {
  key: string;
  title: string;
  panels: ReviewPanel[];
}

function commitRow(commit: string, group: CommitGroup, task?: string): ReviewRow {
  return { kind: "commit", id: `${commit}:${group.path}`, group, commit, ...(task ? { task } : {}) };
}

/** Shared by the Reviews listing and the arrows on its documents. */
export function reviewScopes(context: WorkspaceView): ReviewScope[] {
  const { hierarchy } = context.index;
  const scopes = new Map<string, ReviewScope>();
  for (const project of hierarchy.ordered()) {
    const key = `project:${project.id}`;
    scopes.set(key, { key, title: hierarchy.breadcrumb(project), panels: [] });
  }
  const collections = new Map<string, ReviewScope>();
  const collectionScope = (collection: string) => {
    const key = `collection:${collection}`;
    const scope = collections.get(key) ?? { key, title: `Collection: ${collection}`, panels: [] };
    collections.set(key, scope);
    return scope;
  };
  for (const task of context.workflowOutcomes)
    scopes.get(`project:${task.scope}`)?.panels.push({
      id: `task:${task.id}`,
      task,
      rows: [
        ...context
          .taskDocumentReviews(task.id)
          .flatMap(({ revision, groups }) => groups.map((group) => commitRow(revision, group, task.id))),
        { kind: "task", id: task.id, record: task },
      ],
    });
  const rootKey = `project:${context.projects[0]?.id ?? ""}`;
  for (const unit of context.standaloneCommitReviews) {
    const byScope = new Map<ReviewScope, ReviewRow[]>();
    for (const group of unit.groups) {
      const collection = reviewCollection(group.path);
      const project = collection ? undefined : context.index.projectForPath(group.path);
      const scope = collection ? collectionScope(collection) : scopes.get(project ? `project:${project.id}` : rootKey);
      if (!scope) continue;
      const rows = byScope.get(scope) ?? [];
      rows.push(commitRow(unit.revision, group));
      byScope.set(scope, rows);
    }
    for (const [scope, rows] of byScope) scope.panels.push({ id: `commit:${unit.revision}`, commit: unit, rows });
  }
  for (const section of context.reviewSections) {
    const collection = section.groups[0]?.collection;
    const scope = collection ? collectionScope(collection) : scopes.get(section.key);
    scope?.panels.push({
      id: `working:${section.key}`,
      rows: section.groups.map((group) => ({ kind: "working", id: `working:${group.path}`, group })),
    });
  }
  return [...scopes.values(), ...[...collections.values()].sort((a, b) => a.title.localeCompare(b.title))];
}
