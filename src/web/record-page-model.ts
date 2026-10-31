import type { BrowserRecord } from "../record-service.js";
import { WebError } from "./errors.js";
import { recordURL } from "./locations.js";
import { differenceLayout, DifferenceLayout, type ComparisonBaseline, type DocumentView } from "./navigation-state.js";
import type { ViewContext } from "./view-context.js";

type RecordView = Exclude<DocumentView, "raw">;
function removedDecisionModel(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Record>,
  layout: DifferenceLayout,
) {
  const decision =
    context.comparison?.state === "compared"
      ? context.comparison.decisions.find((item) => item.id === parameters.id && item.status === "removed")
      : undefined;
  if (decision?.status !== "removed") throw new WebError(404, "record not found");
  const requested = parameters.view ?? "read";
  const view = (["read", "source", "changes"] as const).find((view) => view === requested);
  if (!view) throw new WebError(400, "removed decisions are read only");
  const requestedBaseline = parameters.baseline ?? "upstream";
  const baseline = (["head", "upstream"] as const).find((value) => value === requestedBaseline);
  if (!baseline) throw new WebError(400, "unknown comparison baseline");
  return {
    kind: "removed" as const,
    decision,
    view,
    baseline,
    split: layout === DifferenceLayout.Split,
    path: "workbench/collections/" + context.selection + "/" + decision.path,
    base: recordURL(decision.id, { collection: context.selection }),
  };
}
export type RemovedDecisionModel = ReturnType<typeof removedDecisionModel>;

/** Validate capability and comparison choices before composing any record markup. */
export function recordPageModel(context: ViewContext, parameters: RouteQuery<typeof Route.Record>) {
  const layout = differenceLayout(parameters);
  const record = context.index.byId.get(parameters.id ?? "");
  if (!record) return removedDecisionModel(context, parameters, layout);
  const document = context.document(record.id);
  const views: { value: RecordView; label: string }[] = [
    { value: "read", label: "Read" },
    { value: "source", label: "Raw" },
  ];
  if (record.type === "ADR" && !record.local) views.push({ value: "changes", label: "Changes" });
  if (record.editable) views.push({ value: "edit", label: "Edit" });
  const requested = parameters.view ?? "read";
  if (requested === "edit" && !record.editable) throw new WebError(400, "this record is read only");
  if (requested === "changes" && (record.type !== "ADR" || record.local))
    throw new WebError(400, "source differences are available for project-owned ADRs");
  const view = views.find((choice) => choice.value === requested)?.value;
  if (!view) throw new WebError(400, "unknown record view");
  const state = recordViewState(record, view, parameters);
  const comparison = context.comparison;
  return {
    kind: "record" as const,
    record,
    document,
    views,
    state,
    compared: comparison?.state === "compared" ? comparison.decisions.find((item) => item.id === record.id) : undefined,
    related: [
      ...new Set(document.contents.match(/[a-z][a-z0-9_-]*:(?:ADR|TSK|EXP|ENV|CIT|REL)-[0-9A-Z]+/gi) ?? []),
    ].flatMap((id) => context.index.references.record(id) ?? []),
    split: layout === DifferenceLayout.Split,
  };
}
type RecordViewState =
  | { view: Exclude<RecordView, "changes"> }
  | {
      view: "changes";
      baseline: ComparisonBaseline;
      baselines: { value: ComparisonBaseline; label: string }[];
    };
function recordViewState(
  record: BrowserRecord,
  view: RecordView,
  parameters: RouteQuery<typeof Route.Record>,
): RecordViewState {
  if (view !== "changes") return { view };
  const baselines: { value: ComparisonBaseline; label: string }[] = [
    { value: "reviewed", label: "Compare since last review" },
    { value: "head", label: "Compare with committed HEAD" },
  ];
  if (record.collection) baselines.push({ value: "upstream", label: "Compare with pinned upstream" });
  const requested = parameters.baseline ?? (record.collection ? "upstream" : "reviewed");
  const baseline = baselines.find((choice) => choice.value === requested)?.value;
  if (!baseline) throw new WebError(400, "unknown comparison baseline");
  return { view, baseline, baselines };
}

import type { Route, RouteQuery } from "./routes.js";
