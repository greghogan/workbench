import { taskTree } from "./workflow-navigation.js";
import { workflowRecordURL } from "../review/review-navigation.js";
import { taskHadApproval, taskLifecycles, TaskLifecycle } from "../../core/tasks/task-workflow.js";
import { taskTransitionProblem } from "../../core/tasks/task-service.js";
import { recordBatchSize, recordWindowLimit } from "../routes/record-window.js";
import { compareRecordKeys, recordKey } from "../routes/record-listing.js";
import type { TaskRecord } from "../../core/tasks/task-model.js";
import { WebError } from "../http/errors.js";
import type { JSX } from "preact";
import { taskStatuses, type TaskStatus } from "../../core/records/record-document.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
import type { ViewContext } from "../workspace/view-context.js";
import { recordList } from "./record-content.js";
import { shell } from "./page-frame.js";
import { tabs } from "./render-links.js";
import { sourceURL } from "../routes/sources.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { referenceLink } from "./record-links.js";
import { taskDecisionActions } from "./task-decision-actions.js";
import { mutationForm } from "./action-forms.js";
import { submitButton, badge } from "./components.js";
import { Route, type RouteQuery } from "../routes/routes.js";

const compareTasks = (left: TaskRecord, right: TaskRecord) =>
  compareRecordKeys(recordKey(left.reference), recordKey(right.reference));

/** Workflow phases preserve parentage; a parent in another phase remains a contextual link. */
export function taskList(
  context: ViewContext,
  records: BrowserRecord[],
  render: (record: BrowserRecord) => JSX.Element | null = (record) =>
    recordList([record], context, 3, (item) => workflowRecordURL(context, item.id)),
): JSX.Element {
  if (context.index.snapshot.tasks.problem) return recordList(records, context);
  const item = (node: ReturnType<typeof taskTree>[number]): JSX.Element => (
    <li data-task-node={node.record.id} key={node.record.id}>
      {node.parent && (
        <nav aria-label="Parent task">
          {referenceLink(node.parent, node.parent.title, workflowRecordURL(context, node.parent.id))}
        </nav>
      )}
      {render(node.record)}
      {node.children.length > 0 && <ul class="task-tree">{node.children.map(item)}</ul>}
    </li>
  );
  return (
    <ul class="task-tree" data-task-items="">
      {taskTree(context, records).map(item)}
    </ul>
  );
}

export function taskNavigation(context: ViewContext, status?: TaskLifecycle): JSX.Element {
  return tabs(
    [
      { label: "All tasks", href: sourceURL(context, "/records?type=TSK"), current: status === undefined },
      ...taskLifecycles.map((state) => ({
        label: state,
        href: sourceURL(context, routeURL(Route.Records, { type: "TSK", status: state })),
        current: status === state,
      })),
    ],
    "Task views",
  );
}

/** Show plans with their nested work; execution order belongs to the local queue. */
export function tasksPage(
  context: ViewContext,
  records: BrowserRecord[],
  parameters: RouteQuery<typeof Route.Records> = {},
): string {
  let windows: Record<string, string | false> = {};
  if (parameters.task_windows) {
    try {
      const input: unknown = JSON.parse(parameters.task_windows);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.values(input).some((value) => typeof value !== "string" && value !== false) ||
        Object.keys(input).length > recordWindowLimit
      )
        throw new Error("Invalid task windows");
      windows = input as Record<string, string | false>;
    } catch {
      throw new WebError(400, "Invalid task tree window state");
    }
  }
  let displayed = 0;
  const prepared = context.index.snapshot.tasks;
  const status = parameters.status;
  const allRecords = new Map(records.map((record) => [record.id, record]));
  const byId = status ? new Map<string, BrowserRecord>() : allRecords;
  if (status)
    for (const record of records) {
      if (context.taskState(record.id) !== status) continue;
      for (let id: string | undefined = record.id; id && !byId.has(id);) {
        const ancestor = allRecords.get(id);
        if (!ancestor) break;
        byId.set(id, ancestor);
        id = context.index.taskGraph.byReference.get(id)?.parent;
      }
    }
  const tasks = prepared.records.filter((task) => byId.has(task.reference)).sort(compareTasks);
  if (parameters.cursor_revision && parameters.cursor_revision !== context.revision)
    throw new WebError(409, "Task tree changed; refresh before loading more");
  const parent = parameters.parent ? context.index.taskGraph.byReference.get(parameters.parent) : undefined;
  if (parameters.parent && (!parent || !byId.has(parent.reference)))
    throw new WebError(404, "Task parent is unavailable");
  const roots = prepared.problem ? tasks : tasks.filter((task) => !task.parent || !byId.has(task.parent));
  const candidates = parent ? tasks.filter((task) => task.parent === parent.reference) : roots;
  const position = (id: string) => {
    const index = candidates.findIndex((task) => task.reference === id);
    if (index < 0) throw new WebError(409, "Task window changed; refresh the tree");
    return index;
  };
  const start = parameters.after
    ? position(parameters.after) + 1
    : parameters.before
      ? Math.max(0, position(parameters.before) - recordBatchSize)
      : 0;
  const end = parameters.through
    ? position(parameters.through) + 1
    : parameters.before
      ? position(parameters.before)
      : Math.min(candidates.length, start + recordBatchSize);
  if (end < start || end - start > recordWindowLimit) throw new WebError(400, "Task window exceeds its limit");
  const visible = candidates.slice(start, end),
    key = parent?.reference ?? "roots";
  let reserved = visible.length;
  const url = (values: Record<string, string>) => {
    const query = new URLSearchParams({
      type: "TSK",
      ...values,
      ...(status ? { status } : {}),
      ...(parent && !values.parent ? { parent: parent.reference } : {}),
    });
    return sourceURL(context, "/records?" + query.toString());
  };
  const item = (task: (typeof tasks)[number], heading: 2 | 3): JSX.Element | null => {
    reserved--;
    if (++displayed > recordWindowLimit)
      throw new WebError(400, "Task tree window exceeds its limit; collapse branches or open the next task view");
    const record = byId.get(task.reference);
    if (!record) return null;
    const children = prepared.problem
      ? []
      : (context.index.taskGraph.children.get(task.reference) ?? [])
          .filter((child) => byId.has(child.reference))
          .sort(compareTasks);
    const requested = windows[task.reference];
    const through = Object.hasOwn(windows, task.reference)
      ? requested
        ? children.findIndex((child) => child.reference === requested) + 1
        : 0
      : Math.min(children.length, Math.max(0, recordBatchSize - displayed - reserved));
    if (requested && !through) throw new WebError(409, "Task branch changed; refresh the tree");
    const last = children[through - 1]?.reference;
    reserved += through;
    const branchURL = url({
      parent: task.reference,
      ...(last ? { after: last } : {}),
      cursor_revision: context.revision,
    });
    return (
      <li data-task-node={task.reference} key={task.reference}>
        {recordList([record], context, heading, (record) =>
          sourceURL(context, recordURL(record.id, status ? { status } : {})),
        )}
        {children.length > 0 && (
          <details
            data-task-branch={task.reference}
            open={requested !== false && (through > 0 || Object.hasOwn(windows, task.reference))}
          >
            <summary>Subtasks ({children.length})</summary>
            <div data-task-window={task.reference} data-list-revision={context.revision}>
              <ul class="task-tree" data-task-items="">
                {children.slice(0, through).map((child) => item(child, 3))}
              </ul>
              <div data-task-loader="">
                {through < children.length && (
                  <a class="button secondary" data-task-more="" href={branchURL}>
                    {last ? "Load more" : "Load subtasks"}
                  </a>
                )}
              </div>
            </div>
          </details>
        )}
      </li>
    );
  };
  const ancestors: typeof tasks = [];
  let ancestor = parent;
  while (ancestor) {
    ancestors.unshift(ancestor);
    ancestor = ancestor.parent ? context.index.taskGraph.byReference.get(ancestor.parent) : undefined;
    if (ancestors.length > 128) throw new WebError(409, "Task parent cycle");
  }
  return shell(
    context,
    "Tasks",
    "TSK",
    <>
      {taskNavigation(context, status)}
      {prepared.problem && <p class="notice">{prepared.problem}</p>}
      {ancestors.length > 0 && (
        <nav aria-label="Task hierarchy">
          {ancestors.map((task) => (
            <p>
              <a href={recordURL(task.reference)}>{task.title}</a>
            </p>
          ))}
        </nav>
      )}
      <div data-task-window={key} data-list-revision={context.revision}>
        {start > 0 && (
          <a class="button secondary" href={url({ before: visible[0]?.reference ?? "" })}>
            Load previous tasks
          </a>
        )}
        <ul class="task-tree" data-task-items="">
          {visible.map((task) => item(task, 2))}
        </ul>

        {!visible.length && <p>No tasks.</p>}
        <div data-task-loader="">
          {end < candidates.length && (
            <a
              class="button secondary"
              data-task-more=""
              href={url({ after: visible.at(-1)?.reference ?? "", cursor_revision: context.revision })}
            >
              Load more
            </a>
          )}
        </div>
      </div>
      {[...prepared.errors].some(([id]) => byId.has(id)) && (
        <section aria-label="Tasks needing attention">
          <h2>
            <a href={sourceURL(context, "/records?type=TSK&attention=1")}>
              Tasks needing attention ({[...prepared.errors].filter(([id]) => byId.has(id)).length})
            </a>
          </h2>
          {[...prepared.errors]
            .filter(([id]) => byId.has(id))
            .slice(0, Math.max(0, recordBatchSize - visible.length))
            .map(([id, problem]) => (
              <section aria-label="Task needing attention">
                <p class="notice">{problem}</p>
                {recordList(
                  records.filter((record) => record.id === id),
                  context,
                  3,
                )}
              </section>
            ))}
        </section>
      )}
      <output id="task-loading-status" class="sr-only"></output>
    </>,
    { search: { query: "", type: "TSK" }, ...(status ? { taskStatus: status } : {}) },
  );
}

export function taskChildren(context: ViewContext, record: BrowserRecord): JSX.Element | null {
  if (record.type !== "TSK") return null;
  const children = [...(context.index.taskGraph.children.get(record.id) ?? [])].sort(compareTasks).flatMap((task) => {
    const child = context.index.byId.get(task.reference);
    return child ? [child] : [];
  });
  if (!children.length) return null;
  return (
    <section aria-label="Subtasks">
      <h2>Subtasks</h2>
      <ul>
        {children.map((child) => (
          <li key={child.id}>
            {referenceLink(child, child.title)}{" "}
            {context.taskState(child.id) && badge(context.taskState(child.id) ?? "")}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function taskControls(context: ViewContext, record: BrowserRecord): JSX.Element | null {
  if (
    record.type !== "TSK" ||
    record.local ||
    record.collection ||
    !!record.archive ||
    !taskStatuses.some((state) => state === record.status)
  )
    return null;
  const queue = context.index.snapshot.tasks.queue,
    entry = queue.entries.find((entry) => entry.reference === record.id);
  if (context.index.snapshot.tasks.problem) return <p class="notice">{context.index.snapshot.tasks.problem}</p>;
  const task = context.index.taskGraph.byReference.get(record.id);
  if (!task) return null;
  const document = context.document(record.id);
  const fileChanges = document.taskFiles;
  const state = context.taskState(record.id);
  const planActions = !taskHadApproval(task, entry);
  const expected = task.reviewDigest ?? task.digest;
  const readiness = context.index.taskReadiness;
  const decisionForm = (state: TaskStatus, label: string) =>
    mutationForm({
      action: Route.TaskState,
      context,
      csrf: context.csrf,
      fields: { reference: record.id, expected, state },
      children: () => submitButton(label, { secondary: state === "Planned" }),
    });
  const replan = (label: string) =>
    taskTransitionProblem(task, readiness, "Planned") ? null : decisionForm("Planned", label);
  const operationURL = (kind: "cancel" | "delete-plan" | "revert") =>
    sourceURL(
      context,
      routeURL(Route.TaskOperation, { id: record.id, kind, ...(context.workflow ? { workflow: "1" } : {}) }),
    );
  const decision =
    state === TaskLifecycle.Planned || state === TaskLifecycle.AwaitingApproval
      ? ({ state: "Approved", label: "Approve plan" } as const)
      : state === TaskLifecycle.AwaitingAcceptance
        ? ({ state: "Accepted", label: "Accept outcome" } as const)
        : undefined;
  const decisionProblem = decision && taskTransitionProblem(task, readiness, decision.state);
  const acceptance = decisionProblem?.acceptance;
  const primary = decision && !decisionProblem ? decisionForm(decision.state, decision.label) : null;
  const mayCancel =
    state !== TaskLifecycle.Canceled &&
    state !== TaskLifecycle.Accepted &&
    state !== TaskLifecycle.Finalized &&
    !taskTransitionProblem(task, readiness, "Canceled");
  const completed = state === TaskLifecycle.Accepted || state === TaskLifecycle.Finalized;
  const secondary = [
    planActions &&
      !entry &&
      !document.files.length &&
      !readiness.graph.tasks.some(
        (candidate) => candidate.parent === record.id || candidate.dependencies.includes(record.id),
      ) && (
        <a class="button secondary" href={operationURL("delete-plan")}>
          Delete plan
        </a>
      ),
    mayCancel && (
      <a class="button secondary" href={operationURL("cancel")}>
        {planActions ? "Cancel plan" : "Cancel task"}
      </a>
    ),
    (state === TaskLifecycle.AwaitingImplementation || state === TaskLifecycle.AwaitingAcceptance) &&
      replan("Revise plan"),
    (completed || state === TaskLifecycle.Canceled) && replan(planActions ? "Reopen plan" : "Reopen task"),
    completed && context.taskHasDelivery(record.id) && (
      <a class="button secondary" href={operationURL("revert")}>
        Revert work
      </a>
    ),
  ];
  return (
    <section aria-label="Task actions" class="task-workflow">
      {task.approval?.source === "developer-requested-review" && <p class="muted">Review requested by the developer</p>}
      {decisionProblem && (
        <p class="notice">
          {acceptance ? (
            <>
              {acceptance.action}{" "}
              {acceptance.references.map((reference, index) => {
                const prerequisite = context.index.byId.get(reference);
                const href =
                  context.taskState(reference) === TaskLifecycle.AwaitingAcceptance
                    ? workflowRecordURL(context, reference)
                    : sourceURL(context, recordURL(reference));
                return (
                  <span key={reference}>
                    {index ? ", " : ""}
                    {prerequisite ? referenceLink(prerequisite, reference, href) : reference}
                  </span>
                );
              })}{" "}
              first.
            </>
          ) : (
            decisionProblem.message
          )}
        </p>
      )}
      {task.acceptanceNeedsReview && state === TaskLifecycle.AwaitingImplementation && (
        <p class="notice">The current delivery needs verification before it can be accepted.</p>
      )}
      {fileChanges && fileChanges.length > 0 && (
        <ul aria-label="Supporting file changes">
          {fileChanges.map((file) => (
            <li key={file.name}>
              {file.name}: {file.change}
            </li>
          ))}
        </ul>
      )}
      {taskDecisionActions(planActions ? "plan" : "task", primary, secondary)}
    </section>
  );
}
