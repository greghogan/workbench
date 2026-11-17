import type { WorkspaceView } from "../workspace/workspace-service.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { DifferenceLayout, type ReviewView } from "../routes/navigation-state.js";
import { Route } from "../routes/routes.js";
import { sourceURL } from "../routes/sources.js";
import { reviewScopes, type ReviewRow } from "./review-layout.js";
import { basename } from "node:path";

export interface TaskReviewFile {
  commit: string;
  path: string;
}

export function taskReviewFiles(context: WorkspaceView, task: string): TaskReviewFile[] {
  if (!context.workflowOutcomes.some((record) => record.id === task)) return [];
  return context
    .taskDocumentReviews(task)
    .flatMap((unit) => unit.groups.flatMap((group) => group.paths.map((path) => ({ commit: unit.revision, path }))));
}

export function taskReviewLocation(
  context: WorkspaceView,
  task: string,
  file: TaskReviewFile,
  layout?: DifferenceLayout,
): string {
  return sourceURL(context, routeURL(Route.History, { task, ...file, ...(layout ? { layout } : {}) }));
}

export function workflowRecordURL(
  context: Pick<WorkspaceView, "all" | "scope" | "selection">,
  id: string,
  layout?: DifferenceLayout,
): string {
  return sourceURL(
    context,
    id.includes(":plan/") ? recordURL(id) : recordURL(id, { workflow: "1", ...(layout ? { layout } : {}) }),
  );
}

function commitLocation(context: WorkspaceView, file: TaskReviewFile, layout?: DifferenceLayout, task?: string) {
  return task
    ? taskReviewLocation(context, task, file, layout)
    : sourceURL(context, routeURL(Route.History, { ...file, ...(layout ? { layout } : {}) }));
}

export function reviewRowLocation(context: WorkspaceView, row: ReviewRow): string {
  if (row.kind === "task") return workflowRecordURL(context, row.id);
  if (row.kind === "working") return reviewLocation(context, row.group);
  const { group, commit, task } = row;
  const path = group.paths.includes(group.path) ? group.path : (group.paths[0] ?? group.path);
  return commitLocation(context, { commit, path }, undefined, task);
}

export function pendingReviewNeighbors(context: WorkspaceView, id: string, layout?: DifferenceLayout) {
  const steps = context.workflowApprovals.map((record) => ({
    id: record.id,
    title: record.title,
    href: () => workflowRecordURL(context, record.id, layout),
  }));
  if (context.compatibilityNeedsHumanReview)
    steps.push({
      id: "compatibility",
      title: "Policy compatibility",
      href: () => reviewLocation(context, { compatibility: true }),
    });
  for (const scope of reviewScopes(context))
    for (const { rows } of scope.panels)
      for (const row of rows) {
        if (row.kind === "task")
          steps.push({ id: row.id, title: row.record.title, href: () => workflowRecordURL(context, row.id, layout) });
        else if (row.kind === "working")
          steps.push({
            id: row.id,
            title: row.group.record?.title ?? basename(row.group.path),
            href: () => reviewLocation(context, row.group, layout),
          });
        else
          for (const path of row.group.paths)
            steps.push({
              id: `${row.commit}:${path}`,
              title: row.group.record?.title ?? basename(path),
              href: () => commitLocation(context, { commit: row.commit, path }, layout, row.task),
            });
      }
  const position = steps.findIndex((step) => step.id === id);
  const step = (index: number) => {
    const neighbor = steps[index];
    return neighbor && { href: neighbor.href(), title: neighbor.title };
  };
  return {
    label: "review",
    position: position + 1,
    total: steps.length,
    previous: step(position - 1),
    next: position >= 0 ? step(position + 1) : undefined,
  };
}

export function reviewLocation(
  context: WorkspaceView,
  item: { path: string } | { compatibility: true },
  layout: DifferenceLayout = DifferenceLayout.Inline,
  view?: ReviewView,
): string {
  if ("compatibility" in item) return sourceURL(context, routeURL(Route.Review, { compatibility: "1" }));
  const owner = context.index.reviewOwnerPath(item.path);
  const group = context.index.reviews.byOwner.get(owner);
  if (!group?.pending) {
    const unit = context.commitReviewFor(owner),
      prefix = owner.slice(0, -3) + "/",
      path = unit?.paths.find((path) => path === owner || path.startsWith(prefix));
    if (unit && path) {
      const file = { commit: unit.revision, path };
      const task = context.index.reviewTaskOwners.get(unit.revision)?.reference;
      if (task && context.workflowOutcomes.some((record) => record.id === task))
        return taskReviewLocation(context, task, file, layout);
      return sourceURL(context, routeURL(Route.History, { ...file, layout }));
    }
  }
  const selected =
    group && !context.includesWorkflow(group.scope, group.collection)
      ? context.index.select(group.collection ? { collection: group.collection } : { scope: group.scope })
      : context;
  return sourceURL(
    selected,
    routeURL(Route.Review, {
      ...(group?.id ? { id: group.id } : { path: owner }),
      layout,
      ...(view ? { view } : {}),
    }),
  );
}
