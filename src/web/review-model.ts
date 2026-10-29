import { basename } from "node:path";
import { splitFrontmatter } from "../record-document.js";
import { ReviewSource, reviewSource } from "../review-service.js";
import { WebError } from "./errors.js";
import { differenceLayout, DifferenceLayout, type DocumentView } from "./navigation-state.js";
import type { ViewContext } from "./view-context.js";
import { reviewNavigation } from "./review-navigation.js";
import { sourceURL } from "./sources.js";
import { routeURL } from "./locations.js";
import { Route } from "./routes.js";

/** Resolve the exact selected version before any presentation work. */
export function reviewPageModel(context: ViewContext, parameters: URLSearchParams) {
  const path = parameters.get("path");
  if (!path) throw new WebError(400, "select a protected file");
  const change = context.index.reviewChange(
    path,
    parameters.has("review_source") ? reviewSource(parameters.get("review_source")) : undefined,
  );
  if (!change) throw new WebError(404, "protected file version not found; refresh the queue");
  const layout = differenceLayout(parameters),
    document = context.reviewDocument(change.digest);
  const before = document.before === null ? undefined : Buffer.from(document.before, "base64"),
    after = document.after === null ? undefined : Buffer.from(document.after, "base64"),
    contents = after ?? before ?? Buffer.alloc(0);
  const binary = contents.includes(0),
    readable = path.endsWith(".md") && !binary,
    raw = contents.toString("utf8"),
    isADR = /\/ADR-[0-9A-Z]+\.md$/.test(path);
  const heading = readable
    ? (/^#\s+([^\r\n]+)(?:\r?\n|$)/.exec((splitFrontmatter(raw)?.body ?? raw).trimStart())?.[1] ?? basename(path))
    : basename(path);
  const choices: { value: Exclude<DocumentView, "edit" | "source">; label: string }[] = [
    ...(isADR ? [{ value: "changes" as const, label: "Changes" }] : []),
    ...(readable ? [{ value: "read" as const, label: "Read" }] : []),
    { value: "raw", label: "Raw" },
  ];
  const requested = parameters.get("view") ?? (isADR ? "changes" : readable ? "read" : "raw");
  const view = choices.find((choice) => choice.value === requested)?.value;
  if (!view) throw new WebError(400, "unknown review view for this file");
  return {
    path,
    change,
    layout,
    document,
    before,
    after,
    contents,
    binary,
    readable,
    raw,
    isADR,
    heading,
    choices,
    view,
    split: layout === DifferenceLayout.Split,
    version: change.source === ReviewSource.Staged ? "staged" : "working",
    navigation: reviewNavigation(context, change.digest),
    base: sourceURL(context, routeURL(Route.Review, { path, review_source: change.source })),
    beforeMode: change.before.split(":")[0] ?? "unknown",
    afterMode: change.after.split(":")[0] ?? "unknown",
    alternative: context.index.reviewChange(
      path,
      change.source === ReviewSource.Staged ? ReviewSource.Working : ReviewSource.Staged,
    ),
    record: context.index.byPath.get(path),
  };
}
