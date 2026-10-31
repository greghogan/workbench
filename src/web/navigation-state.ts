import type { WorkspaceView } from "../workspace-service.js";
import { sourceURL } from "./sources.js";
import type { RouteQuery, Route } from "./routes.js";
import type { SearchType } from "./view-context.js";

export const DifferenceLayout = { Inline: "unified", Split: "split" } as const;
export type DifferenceLayout = (typeof DifferenceLayout)[keyof typeof DifferenceLayout];
export type DocumentView = "read" | "source" | "raw" | "changes" | "edit";
export type ComparisonBaseline = "head" | "reviewed" | "upstream";
export interface ViewState {
  view?: DocumentView;
  layout?: DifferenceLayout;
  baseline?: ComparisonBaseline;
}
/** A view transition changes named parameters while retaining its source and comparison context. */
export function viewLocation(context: WorkspaceView, base: string, parameters: ViewState, changes: ViewState): string {
  const url = new URL(base, "http://workbench.invalid");
  for (const key of ["layout", "baseline"] as const) {
    const value = parameters[key];
    if (value) url.searchParams.set(key, value);
  }
  for (const key of ["view", "layout", "baseline"] as const) {
    const value = changes[key];
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return sourceURL(context, url.pathname + url.search);
}
export function differenceLayout(parameters: Pick<ViewState, "layout">): DifferenceLayout {
  return parameters.layout ?? DifferenceLayout.Inline;
}
export function recordSearch(parameters: RouteQuery<typeof Route.Records>): {
  query: string;
  type: SearchType;
  scope: string;
} {
  return { query: parameters.q ?? "", type: parameters.type ?? "", scope: parameters.scope ?? "" };
}
