import type { BrowserRecord } from "../../core/records/record-service.js";
import { basename } from "node:path";
import { taskPhase, TaskPhase } from "../../core/tasks/task-workflow.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import { Route } from "../routes/routes.js";
import type { DifferenceLayout } from "../routes/navigation-state.js";
import { taskReviewFiles, taskReviewLocation, type TaskReviewFile } from "../review/review-navigation.js";
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
export function workflowRecordURL(
  context: Pick<ViewContext, "all" | "scope" | "selection">,
  id: string,
  layout?: DifferenceLayout,
): string {
  return sourceURL(
    context,
    id.includes(":plan/") ? recordURL(id) : recordURL(id, { workflow: "1", ...(layout ? { layout } : {}) }),
  );
}
/** Task reviews follow the queue order, with each outcome following its pending documents. */
export function taskReviewNeighbors(
  context: ViewContext,
  id: string,
  layout?: DifferenceLayout,
  document?: { position: number; files: readonly TaskReviewFile[] },
) {
  const outcomes = context.workflowOutcomes,
    position = outcomes.findIndex((task) => task.id === id);
  if (position < 0) return { previous: undefined, next: undefined };
  const outcome = (task: BrowserRecord | undefined) =>
    task
      ? {
          href: workflowRecordURL(context, task.id, layout),
          title: task.title,
        }
      : undefined;
  const file = (task: string, review: TaskReviewFile | undefined) =>
    review
      ? {
          href: taskReviewLocation(context, task, review, layout),
          title: context.index.byPath.get(review.path)?.title ?? basename(review.path),
        }
      : undefined;
  const before = outcomes[position - 1];
  if (document)
    return {
      previous: file(id, document.files[document.position - 1]) ?? outcome(before),
      next: file(id, document.files[document.position + 1]) ?? outcome(outcomes[position]),
    };
  const after = outcomes[position + 1];
  return {
    previous: file(id, taskReviewFiles(context, id).at(-1)) ?? outcome(before),
    next: (after && file(after.id, taskReviewFiles(context, after.id)[0])) ?? outcome(after),
  };
}

export function taskWorkflowNavigation(context: ViewContext, id: string, layout?: DifferenceLayout) {
  const task = context.index.taskGraph.byReference.get(id),
    entry = context.index.snapshot.tasks.queue.entries.find((entry) => entry.reference === id),
    phase =
      (task ? taskPhase(task, entry) : undefined) ??
      (context.workflowOutcomes.some((record) => record.id === id) ? TaskPhase.Reviews : undefined);
  if (!phase) return { phase, active: undefined, parents: [], previous: undefined, next: undefined };
  const route = phase === TaskPhase.Plans ? Route.Plans : phase === TaskPhase.Work ? Route.Work : Route.Reviews;
  const parents = [workflowParent(context, route)];
  if (phase === TaskPhase.Reviews)
    return { phase, active: "review" as const, parents, ...taskReviewNeighbors(context, id, layout) };
  const records =
    phase === TaskPhase.Plans
      ? context.workflowPlans
      : context.workflowWork.flatMap((task) => context.index.byId.get(task.reference) ?? []);
  const ordered: BrowserRecord[] = [];
  const flatten = (nodes: TaskNode[]) => {
    for (const node of nodes) {
      ordered.push(node.record);
      flatten(node.children);
    }
  };
  if (phase === TaskPhase.Work) {
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const entry of context.taskQueue.entries) {
      const record = byId.get(entry.reference);
      if (record) {
        ordered.push(record);
        byId.delete(entry.reference);
      }
    }
    flatten(taskTree(context, [...byId.values()]));
  } else flatten(taskTree(context, records));
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
  if (!context.workflow) return;
  if (record.type === "TSK") return taskWorkflowNavigation(context, record.id, layout);
  if (record.type !== "EXP") return;
  const work = context.experimentWorkflow.filter((item) => item.phase === "work");
  const index = work.findIndex((item) => item.record.id === record.id);
  if (index < 0) return;
  const step = (item: (typeof work)[number] | undefined) =>
    item ? { href: workflowRecordURL(context, item.record.id), title: item.record.title } : undefined;
  return {
    phase: TaskPhase.Work,
    active: "work" as const,
    parents: [workflowParent(context, Route.Work)],
    previous: step(work[index - 1]),
    next: step(work[index + 1]),
  };
}
