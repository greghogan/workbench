import type { WorkspaceView } from "../workspace-service.js";
import { routeURL } from "./locations.js";
import { DifferenceLayout } from "./navigation-state.js";
import { Route } from "./routes.js";

export function reviewLocation(
  context: WorkspaceView,
  item: { path: string } | { compatibility: true },
  layout: DifferenceLayout = DifferenceLayout.Inline,
): string {
  if ("compatibility" in item) return routeURL(Route.Review, { compatibility: "1" });
  const owner = context.index.reviewOwnerPath(item.path);
  const group = context.index.reviewGroups.get(owner);
  return routeURL(Route.Review, { ...(group?.id ? { id: group.id } : { path: owner }), layout });
}

export function reviewNavigation(context: WorkspaceView, digest: string) {
  const items = context.reviewQueue;
  const group = context.index.reviewGroupByDigest.get(digest);
  const index = group ? items.indexOf(group) : -1;
  const current = items[index];
  const pending = (group: WorkspaceView["reviewGroups"][number]) =>
    group.changes.some((change) => !change.approved && change.digest !== digest);
  const originalIndex = group ? context.reviewGroups.indexOf(group) : -1;
  const nextPending =
    current && pending(current)
      ? current
      : originalIndex >= 0
        ? [...context.reviewGroups.slice(originalIndex + 1), ...context.reviewGroups.slice(0, originalIndex)].find(
            pending,
          )
        : items.find(pending);
  return {
    position: index + 1,
    total: context.pendingReviews,
    previous: index > 0 ? items[index - 1] : undefined,
    next:
      index >= 0
        ? (items[index + 1] ?? (context.compatibilityNeedsHumanReview ? { compatibility: true as const } : undefined))
        : undefined,
    nextPending: nextPending ?? (context.compatibilityNeedsHumanReview ? { compatibility: true as const } : undefined),
  };
}
