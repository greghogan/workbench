import { classifyRecordPath, recordOwnerPath } from "../../core/records/staged-records.js";
import { WebError } from "../http/errors.js";
import { DifferenceLayout, type ReviewView } from "../routes/navigation-state.js";
import { decodeRouteQuery, Route } from "../routes/routes.js";
import type { WorkspaceIndex } from "../workspace/workspace-service.js";

export interface ReviewTarget {
  path: string;
  layout: DifferenceLayout;
  view?: ReviewView;
  task?: { reference: string; expected: string };
  workflow?: "1";
  recordView?: "read" | "changes";
}

/** Resolve the owned record once before any preparation side effects. */
export function decodeReviewTarget(form: URLSearchParams, index: WorkspaceIndex): ReviewTarget {
  const path = form.get("path");
  if (!path) throw new WebError(400, "select a record to review");
  const record = index.byPath.get(path);
  if (record?.type === "TSK" && !record.collection && !record.local && !record.archive) {
    const expected = form.get("expected") ?? "";
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new WebError(400, "Supply the inspected plan version");
    const query = decodeRouteQuery(
      Route.Record,
      new URLSearchParams({
        id: record.id,
        layout: form.get("review_layout") ?? DifferenceLayout.Inline,
        ...(form.get("record_view") ? { view: form.get("record_view") ?? "" } : {}),
        ...(form.get("workflow") ? { workflow: form.get("workflow") ?? "" } : {}),
      }),
    );
    if (query.view && query.view !== "read" && query.view !== "changes")
      throw new WebError(400, "Prepare a plan for review");
    return {
      path,
      layout: query.layout ?? DifferenceLayout.Inline,
      task: { reference: record.id, expected },
      ...(query.view ? { recordView: query.view } : {}),
      ...(query.workflow ? { workflow: query.workflow } : {}),
    };
  }
  const view = form.get("review_view");
  const query = decodeRouteQuery(
    Route.Review,
    new URLSearchParams({
      path,
      layout: form.get("review_layout") ?? DifferenceLayout.Inline,
      ...(view ? { view } : {}),
    }),
  );
  const scopes = index.snapshot.projects.map((project) => project.path);
  const deleted = index.reviews.byPath.get(path)?.after.startsWith("000000:") === true;
  if (
    recordOwnerPath(path, scopes, index.sources) !== path ||
    (!classifyRecordPath(path, scopes, index.sources).protected && !deleted)
  )
    throw new WebError(400, "select a protected record, not a supporting file or implementation path");
  if (!index.byPath.has(path) && !deleted)
    throw new WebError(404, "protected record not found; refresh the review queue");
  return { path, layout: query.layout ?? DifferenceLayout.Inline, ...(query.view ? { view: query.view } : {}) };
}
