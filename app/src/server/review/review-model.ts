import { hasReviewBaseline } from "./comparison-result.js";
import { basename } from "node:path";
import { splitFrontmatter } from "../../core/records/record-document.js";
import { WebError } from "../http/errors.js";
import { differenceLayout, DifferenceLayout, type ReviewView } from "../routes/navigation-state.js";
import type { ViewContext } from "../workspace/view-context.js";
import { reviewLocation } from "./review-navigation.js";
import { Route, type RouteQuery } from "../routes/routes.js";

export function reviewHeading(contents: string, path: string): string {
  return (
    /^#\s+([^\r\n]+)(?:\r?\n|$)/.exec((splitFrontmatter(contents)?.body ?? contents).trimStart())?.[1] ?? basename(path)
  );
}

type ReviewPresentation =
  { kind: "diff" } | { kind: "markdown"; text: string } | { kind: "text"; text: string } | { kind: "binary" };

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
  const readableBytes = (bytes: Buffer | undefined) =>
    bytes !== undefined && path.endsWith(".md") && !bytes.includes(0);
  const comparable =
    context.index.reviewOwnerPath(path) === path &&
    readableBytes(previous) &&
    readableBytes(after) &&
    hasReviewBaseline(document.baseline);
  const operation = after === undefined ? "deletion" : previous === undefined ? "addition" : "change";
  const confirmation =
    operation === "deletion" ? "Confirm deletion" : operation === "addition" ? "Confirm new file" : "Confirm changes";
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
  const presentation: ReviewPresentation = comparable
    ? { kind: "diff" }
    : binary
      ? { kind: "binary" }
      : readable
        ? { kind: "markdown", text: raw }
        : { kind: "text", text: raw };
  const heading = reviewHeading((after ?? previous ?? Buffer.alloc(0)).toString("utf8"), path);
  return {
    path,
    change,
    layout,
    document,
    before,
    after,
    contents,
    presentation,
    downloadBefore: presentation.kind === "binary" || presentation.kind === "text",
    operation,
    confirmation,
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

export function resolveReviewPage(context: ViewContext, parameters: RouteQuery<typeof Route.Review>) {
  if (parameters.id && parameters.path) throw new WebError(400, "select a record or a file, not both");
  const path = parameters.id ? context.index.reviews.byId.get(parameters.id)?.path : parameters.path;
  if (parameters.id && !path) throw new WebError(404, "protected record not found; refresh the queue");
  if (!path) return null;
  const owner = context.index.reviewOwnerPath(path);
  const group = context.index.reviews.byOwner.get(owner);
  if (!group) throw new WebError(404, "protected record not found; refresh the queue");
  if (!context.includesWorkflow(group.scope, group.collection))
    throw new WebError(404, "protected record is outside the selected source");
  if (group.pending === 0) return null;
  return { owner, group, layout: differenceLayout(parameters), heading: group.record?.title ?? basename(owner) };
}

export function prepareReviewPage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Review>,
  target = resolveReviewPage(context, parameters),
) {
  if (!target) return null;
  const { owner, group } = target;
  const selected = context.index.reviewChange(owner);
  const primaryParameters = { ...parameters, path: owner };
  const primary =
    selected && context.index.reviews.needsReview(selected) ? reviewPageModel(context, primaryParameters) : undefined;
  const layout = differenceLayout(parameters);
  const supporting = group.changes
    .filter((change) => change.path !== owner && context.index.reviews.needsReview(change))
    .map((change) => reviewPageModel(context, { path: change.path, layout }));
  const unchanged = group.record ? context.document(group.record.id).contents : undefined;
  const heading = primary?.heading ?? (unchanged !== undefined ? reviewHeading(unchanged, owner) : basename(owner));
  return {
    primary,
    supporting,
    unchanged,
    heading,
    owner,
    layout,
    presentations: [...(primary ? [primary] : []), ...supporting].filter((model) => model.canApprove),
  };
}
