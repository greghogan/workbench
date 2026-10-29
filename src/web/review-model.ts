import { hasReviewBaseline } from "./comparison-result.js";
import { basename } from "node:path";
import { splitFrontmatter } from "../record-document.js";
import { WebError } from "./errors.js";
import { differenceLayout, DifferenceLayout, type ReviewView } from "./navigation-state.js";
import type { ViewContext } from "./view-context.js";
import { reviewLocation } from "./review-navigation.js";
import { Route, type RouteQuery } from "./routes.js";

export function reviewHeading(contents: string, path: string): string {
  return (
    /^#\s+([^\r\n]+)(?:\r?\n|$)/.exec((splitFrontmatter(contents)?.body ?? contents).trimStart())?.[1] ?? basename(path)
  );
}

/** Resolve the exact selected version before any presentation work. */
export function reviewPageModel(context: ViewContext, parameters: RouteQuery<typeof Route.Review>) {
  const path = parameters.path;
  if (!path) throw new WebError(400, "select a protected file");
  const change = context.index.reviewChange(path);
  if (!change) throw new WebError(404, "protected file version not found; refresh the queue");
  const layout = differenceLayout(parameters),
    document = context.reviewDocument(change.digest);
  const before = document.before === null ? undefined : Buffer.from(document.before, "base64"),
    after = document.after === null ? undefined : Buffer.from(document.after, "base64"),
    previous = document.baselineContents === null ? before : Buffer.from(document.baselineContents);
  const isADR = /\/ADR-[0-9A-Z]+\.md$/.test(path) && context.index.reviewOwnerPath(path) === path;
  const comparable = isADR && hasReviewBaseline(document.baseline);
  const readableBytes = (bytes: Buffer | undefined) =>
    bytes !== undefined && path.endsWith(".md") && !bytes.includes(0);
  const choices: { value: ReviewView; label: string }[] = [
    ...(comparable ? [{ value: "diff" as const, label: "Diff" }] : []),
    ...(!comparable && readableBytes(previous) ? [{ value: "previous" as const, label: "Previous" }] : []),
    ...(!comparable && readableBytes(after) ? [{ value: "current" as const, label: "Current" }] : []),
    ...(!comparable && !readableBytes(previous) && !readableBytes(after)
      ? [{ value: "current" as const, label: "Current" }]
      : []),
  ];
  const requested =
    parameters.view ??
    (comparable ? "diff" : readableBytes(after) ? "current" : readableBytes(previous) ? "previous" : "current");
  const view = choices.find((choice) => choice.value === requested)?.value;
  if (!view) throw new WebError(400, "unknown review view for this file");
  const contents = (view === "previous" ? previous : (after ?? previous)) ?? Buffer.alloc(0);
  const binary = contents.includes(0),
    readable = path.endsWith(".md") && !binary,
    raw = contents.toString("utf8");
  const heading = reviewHeading((after ?? previous ?? Buffer.alloc(0)).toString("utf8"), path);
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
    comparable,
    heading,
    choices,
    view,
    split: layout === DifferenceLayout.Split,
    base: reviewLocation(context, { path }, layout),
    canApprove: view !== "previous" || after === undefined,
    beforeMode: change.before.split(":")[0] ?? "unknown",
    afterMode: change.after.split(":")[0] ?? "unknown",
    record: context.index.byPath.get(path) ?? { directory: context.root, path },
  };
}
