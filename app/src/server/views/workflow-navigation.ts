import type { BrowserRecord } from "../../core/records/record-service.js";
import { taskPhase, TaskPhase } from "../../core/tasks/task-workflow.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import { Route } from "../routes/routes.js";
import type { DifferenceLayout } from "../routes/navigation-state.js";
import { pendingReviewNeighbors, workflowRecordURL } from "../review/review-navigation.js";
import type { ViewContext } from "../workspace/view-context.js";
import type { Breadcrumb } from "./breadcrumbs.js";

export function workflowParent(
  context: ViewContext,
  route: typeof Route.Plans | typeof Route.Work | typeof Route.Reviews,
): Breadcrumb {
  return {
    label: route === Route.Plans ? "Plans" : route === Route.Work ? "Work" : "Reviews",
    href: sourceURL(context, route),
  };
}

interface TaskNode {
  record: BrowserRecord;
  parent?: BrowserRecord;
  children: TaskNode[];
}
/** A phase keeps its task hierarchy; omitted ancestors are contextual links rather than duplicate work. */
export function taskTree(context: ViewContext, records: readonly BrowserRecord[]): TaskNode[] {
  const nodes = new Map<string, TaskNode>(),
    roots: TaskNode[] = [];
  for (const record of records) nodes.set(record.id, { record, children: [] });
  for (const record of records) {
    const node = nodes.get(record.id);
    if (!node) continue;
    const direct = context.index.taskGraph.byReference.get(record.id)?.parent;
    if (direct && !nodes.has(direct)) {
      const parent = context.index.byId.get(direct);
      if (parent) node.parent = parent;
    }
    let ancestor = direct;
    while (ancestor && !nodes.has(ancestor)) ancestor = context.index.taskGraph.byReference.get(ancestor)?.parent;
    const parent = ancestor ? nodes.get(ancestor) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
export function taskWorkflowNavigation(context: ViewContext, id: string, layout?: DifferenceLayout) {
  const task = context.index.taskGraph.byReference.get(id);
  const entry = context.index.taskReadiness.entries.get(id);
  const phase = task && taskPhase(task, entry);
  if (!phase || (phase === TaskPhase.Work && !entry))
    return { phase: undefined, active: undefined, parents: [], previous: undefined, next: undefined };
  const route = phase === TaskPhase.Plans ? Route.Plans : phase === TaskPhase.Work ? Route.Work : Route.Reviews;
  const parents = [workflowParent(context, route)];
  if (phase === TaskPhase.Reviews)
    return { phase, active: "review" as const, parents, ...pendingReviewNeighbors(context, id, layout) };
  const ordered: BrowserRecord[] = [];
  const flatten = (nodes: TaskNode[]) => {
    for (const node of nodes) {
      ordered.push(node.record);
      flatten(node.children);
    }
  };
  if (phase === TaskPhase.Plans) flatten(taskTree(context, context.workflowPlans));
  else ordered.push(...context.workflowWork.flatMap((task) => context.index.byId.get(task.reference) ?? []));
  const index = ordered.findIndex((record) => record.id === id),
    step = (record: BrowserRecord | undefined) =>
      record ? { href: workflowRecordURL(context, record.id), title: record.title } : undefined;
  return {
    phase,
    active: phase,
    parents,
    previous: index > 0 ? step(ordered[index - 1]) : undefined,
    next: index >= 0 ? step(ordered[index + 1]) : undefined,
  };
}

export function taskRecordTrail(context: ViewContext, record: Pick<BrowserRecord, "id" | "title">) {
  const navigation = context.workflow ? taskWorkflowNavigation(context, record.id) : undefined;
  const href = navigation?.phase ? workflowRecordURL(context, record.id) : sourceURL(context, recordURL(record.id));
  return {
    active: navigation?.active ?? ("TSK" as const),
    href,
    parents: [...(navigation?.phase ? navigation.parents : [tasksParent(context)]), { label: record.title, href }],
  };
}

export function tasksParent(context: ViewContext): Breadcrumb {
  return { label: "Tasks", href: sourceURL(context, routeURL(Route.Records, { type: "TSK" })) };
}

export function recordWorkflowNavigation(
  context: ViewContext,
  record: Pick<BrowserRecord, "id" | "type">,
  layout?: DifferenceLayout,
) {
  if (context.workflow && record.type === "TSK") return taskWorkflowNavigation(context, record.id, layout);
  return undefined;
}
