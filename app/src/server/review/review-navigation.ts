import type { WorkspaceView } from "../workspace/workspace-service.js";
import { routeURL } from "../routes/locations.js";
import { DifferenceLayout, type ReviewView } from "../routes/navigation-state.js";
import { Route } from "../routes/routes.js";
import { sourceURL } from "../routes/sources.js";

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
    if (unit && path) return sourceURL(context, routeURL(Route.History, { commit: unit.revision, path, layout }));
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
