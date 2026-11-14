import { WebError } from "../http/errors.js";
import { routeURL } from "./locations.js";
import { Route, type RouteQuery } from "./routes.js";
import { recordBatchSize, recordWindowLimit } from "./record-window.js";
import type { ViewContext } from "../workspace/view-context.js";

const phases = ["plans", "work", "available", "outcomes"] as const;
export type WorkflowPhase = (typeof phases)[number];

/** Each phase keeps its own cursor; the complete restored page still obeys the shared browser bound. */
export function workflowWindows(
  context: Pick<ViewContext, "revision" | "scope" | "selection" | "all">,
  parameters: RouteQuery<typeof Route.TaskQueue>,
) {
  if (parameters.cursor_revision && parameters.cursor_revision !== context.revision)
    throw new WebError(409, "Workflow changed; refresh before loading more");
  if ((parameters.after || parameters.before || parameters.through) && !parameters.phase)
    throw new WebError(400, "Select a workflow phase for its cursor");
  if (parameters.after && parameters.before) throw new WebError(400, "Select one workflow direction");
  let windows: Record<string, string> = {};
  if (parameters.task_windows) {
    let input: unknown;
    try {
      input = JSON.parse(parameters.task_windows);
    } catch {
      throw new WebError(400, "Invalid workflow windows");
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !phases.some((phase) => key === `workflow-${phase}`)) ||
      Object.values(input).some((value) => typeof value !== "string")
    )
      throw new WebError(400, "Invalid workflow windows");
    windows = input as Record<string, string>;
  }
  return <T>(phase: WorkflowPhase, items: readonly T[], id: (item: T) => string) => {
    const key = `workflow-${phase}`,
      selected = parameters.phase === phase,
      position = (reference: string) => {
        const index = items.findIndex((item) => id(item) === reference);
        if (index < 0) throw new WebError(409, "Workflow order changed; refresh before loading more");
        return index;
      },
      batch = Math.min(recordBatchSize, Math.floor(recordWindowLimit / phases.length)),
      start =
        selected && parameters.after
          ? position(parameters.after) + 1
          : selected && parameters.before
            ? Math.max(0, position(parameters.before) - batch)
            : 0,
      through = selected ? parameters.through : windows[key],
      end = through
        ? position(through) + 1
        : selected && parameters.before
          ? position(parameters.before)
          : Math.min(items.length, start + batch);
    if (end < start || end - start > recordWindowLimit) throw new WebError(400, "Workflow window exceeds its limit");
    const visible = items.slice(start, end),
      first = visible[0],
      last = visible.at(-1),
      url = (values: { after?: string; before?: string }) =>
        routeURL(Route.TaskQueue, {
          scope: context.scope,
          collection: context.selection,
          ...(context.all ? { all: "1" } : {}),
          phase,
          ...values,
          cursor_revision: context.revision,
        });
    return {
      key,
      visible,
      through: last === undefined ? undefined : id(last),
      previous: start > 0 && first !== undefined ? url({ before: id(first) }) : undefined,
      next: end < items.length && last !== undefined ? url({ after: id(last) }) : undefined,
    };
  };
}
