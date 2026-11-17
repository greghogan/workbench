import { WebError } from "../http/errors.js";
import { sourceURL } from "./sources.js";
import { routeURL } from "./locations.js";
import { Route, type WorkflowQuery } from "./routes.js";
import { recordBatchSize, recordWindowLimit } from "./record-window.js";
import type { ViewContext } from "../workspace/view-context.js";

export type WorkflowPhase = NonNullable<WorkflowQuery["phase"]>;
export type WorkflowRoute = typeof Route.Plans | typeof Route.Work | typeof Route.Reviews;

/** Each phase keeps its own cursor; the complete restored page still obeys the shared browser bound. */
export function workflowWindows(
  context: Pick<ViewContext, "revision" | "scope" | "selection" | "all">,
  parameters: WorkflowQuery,
  route: WorkflowRoute,
) {
  const problem = (status: 400 | 409, message: string) =>
    new WebError(status, message, { recovery: { href: sourceURL(context, route), label: "Refresh workflow" } });
  const phases: readonly WorkflowPhase[] =
    route === Route.Plans ? ["plans"] : route === Route.Work ? ["work", "available", "experiments"] : ["reviews"];
  if (parameters.phase && !phases.includes(parameters.phase))
    throw problem(400, "Select a phase from this workflow page");
  if (parameters.cursor_revision && parameters.cursor_revision !== context.revision)
    throw problem(409, "Workflow changed; refresh before loading more");
  if ((parameters.after || parameters.before || parameters.through) && !parameters.phase)
    throw problem(400, "Select a workflow phase for its cursor");
  if (parameters.after && parameters.before) throw problem(400, "Select one workflow direction");
  let windows: Record<string, string> = {};
  if (parameters.task_windows) {
    let input: unknown;
    try {
      input = JSON.parse(parameters.task_windows);
    } catch {
      throw problem(400, "Invalid workflow windows");
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !phases.some((phase) => key === `workflow-${phase}`)) ||
      Object.values(input).some((value) => typeof value !== "string")
    )
      throw problem(400, "Invalid workflow windows");
    windows = input as Record<string, string>;
  }
  return <T>(phase: WorkflowPhase, items: readonly T[], id: (item: T) => string) => {
    const key = `workflow-${phase}`,
      selected = parameters.phase === phase,
      position = (reference: string) => {
        const index = items.findIndex((item) => id(item) === reference);
        if (index < 0) throw problem(409, "Workflow order changed; refresh before loading more");
        return index;
      },
      batch = Math.max(1, Math.floor(recordBatchSize / phases.length)),
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
    if (end < start || end - start > recordWindowLimit) throw problem(400, "Workflow window exceeds its limit");
    const visible = items.slice(start, end),
      first = visible[0],
      last = visible.at(-1),
      url = (values: { after?: string; before?: string }) =>
        sourceURL(
          context,
          routeURL(route, {
            phase,
            ...values,
            cursor_revision: context.revision,
          }),
        );
    return {
      key,
      visible,
      through: last === undefined ? undefined : id(last),
      previous: start > 0 && first !== undefined ? url({ before: id(first) }) : undefined,
      next: end < items.length && last !== undefined ? url({ after: id(last) }) : undefined,
    };
  };
}
