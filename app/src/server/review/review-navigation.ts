import type { WorkspaceView } from "../workspace/workspace-service.js";
import { routeURL } from "../routes/locations.js";
import { DifferenceLayout, type ReviewView } from "../routes/navigation-state.js";
import { Route } from "../routes/routes.js";
import { sourceURL } from "../routes/sources.js";

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
