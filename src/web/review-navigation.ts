import type { WorkspaceView } from "../workspace-service.js";
import { sourceURL } from "./sources.js";
import { routeURL } from "./locations.js";
import { DifferenceLayout } from "./navigation-state.js";
import { Route } from "./routes.js";

type ReviewItem = WorkspaceView["selectedReviews"][number];

export function reviewLocation(
  context: WorkspaceView,
  item: ReviewItem,
  layout: DifferenceLayout = DifferenceLayout.Inline,
): string {
  return sourceURL(context, routeURL(Route.Review, { path: item.path, review_source: item.source, layout }));
}

export function reviewNavigation(context: WorkspaceView, digest: string) {
  const items = context.selectedReviews;
  const index = items.findIndex((item) => item.digest === digest);
  return {
    position: index + 1,
    total: items.length,
    previous: index > 0 ? items[index - 1] : undefined,
    next: index >= 0 ? items[index + 1] : undefined,
    nextPending: index >= 0 ? items.slice(index + 1).find((item) => !item.approved) : undefined,
  };
}
