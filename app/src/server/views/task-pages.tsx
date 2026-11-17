import { taskTree, workflowRecordURL } from "./workflow-navigation.js";
import { taskPhase, TaskPhase } from "../../core/tasks/task-workflow.js";
import { taskTransitionProblem } from "../../core/tasks/task-service.js";
import { recordBatchSize, recordWindowLimit } from "../routes/record-window.js";
import { WebError } from "../http/errors.js";
import type { JSX } from "preact";
import { taskStatuses, terminalTask, type TaskStatus } from "../../core/records/record-document.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
import { queueDigest, TaskExecution } from "../../core/tasks/task-queue.js";
import type { ViewContext } from "../workspace/view-context.js";
import { recordList } from "./record-content.js";
import { shell } from "./page-frame.js";
import { tabs } from "./render-links.js";
import { sourceURL } from "../routes/sources.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { referenceLink } from "./record-links.js";
import { mutationForm } from "./action-forms.js";
import { submitButton, badge } from "./components.js";
import { Route, type RouteQuery } from "../routes/routes.js";

const taskOverviewOrder: readonly TaskStatus[] = ["Approved", "Planned", "Accepted", "Canceled"];

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

export function taskNavigation(context: ViewContext, status?: TaskStatus): JSX.Element {
  return tabs(
    [
      { label: "All tasks", href: sourceURL(context, "/records?type=TSK"), current: status === undefined },
      ...taskStatuses.map((state) => ({
        label: state,
        href: sourceURL(context, "/records?type=TSK&status=" + state),
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
  const byId = new Map(records.map((record) => [record.id, record]));
  const tasks = prepared.records.filter((task) => byId.has(task.reference));
  if (parameters.cursor_revision && parameters.cursor_revision !== context.revision)
    throw new WebError(409, "Task tree changed; refresh before loading more");
  const parent = parameters.parent ? context.index.taskGraph.byReference.get(parameters.parent) : undefined;
  if (parameters.parent && (!parent || !byId.has(parent.reference)))
    throw new WebError(404, "Task parent is unavailable");
  const roots = prepared.problem ? tasks : tasks.filter((task) => !task.parent || !byId.has(task.parent));
  const candidates = parent
    ? tasks.filter((task) => task.parent === parent.reference)
    : taskOverviewOrder.flatMap((status) => roots.filter((task) => task.metadata.status === status));
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
    const query = new URLSearchParams({ type: "TSK", ...values, ...(parent ? { parent: parent.reference } : {}) });
    return sourceURL(context, "/records?" + query.toString());
  };
  const item = (task: (typeof tasks)[number]): JSX.Element | null => {
    reserved--;
    if (++displayed > recordWindowLimit)
      throw new WebError(400, "Task tree window exceeds its limit; collapse branches or open the next task view");
    const record = byId.get(task.reference);
    if (!record) return null;
    const children = prepared.problem
      ? []
      : (context.index.taskGraph.children.get(task.reference) ?? []).filter((child) => byId.has(child.reference));
    const requested = windows[task.reference];
    const through = Object.hasOwn(windows, task.reference)
      ? requested
        ? children.findIndex((child) => child.reference === requested) + 1
        : 0
      : Math.min(children.length, Math.max(0, recordBatchSize - displayed - reserved));
    if (requested && !through) throw new WebError(409, "Task branch changed; refresh the tree");
    const last = children[through - 1]?.reference;
    reserved += through;
    const branchURL = sourceURL(
      context,
      "/records?type=TSK&parent=" +
        encodeURIComponent(task.reference) +
        (last ? "&after=" + encodeURIComponent(last) : "") +
        "&cursor_revision=" +
        context.revision,
    );
    return (
      <li data-task-node={task.reference} key={task.reference}>
        {recordList([record], context, 3)}
        {children.length > 0 && (
          <details
            data-task-branch={task.reference}
            open={requested !== false && (through > 0 || Object.hasOwn(windows, task.reference))}
          >
            <summary>Subtasks ({children.length})</summary>
            <div data-task-window={task.reference} data-list-revision={context.revision}>
              <ul class="task-tree" data-task-items="">
                {children.slice(0, through).map((child) => item(child))}
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
      {taskNavigation(context)}
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
        {parent ? (
          <ul class="task-tree" data-task-items="">
            {visible.map(item)}
          </ul>
        ) : (
          <div data-task-items="">
            {taskOverviewOrder.map((status) => {
              const group = visible.filter((task) => task.metadata.status === status);
              return (
                group.length > 0 && (
                  <section aria-label={status} data-task-group={status}>
                    <h2>{status}</h2>
                    <ul class="task-tree" data-task-group-items="">
                      {group.map(item)}
                    </ul>
                  </section>
                )
              );
            })}
          </div>
        )}

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
    { search: { query: "", type: "TSK" } },
  );
}

export function taskChildren(context: ViewContext, record: BrowserRecord): JSX.Element | null {
  if (record.type !== "TSK") return null;
  const children = (context.index.taskGraph.children.get(record.id) ?? []).flatMap((task) => {
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
            {referenceLink(child, child.title)} {child.status && badge(child.status)}
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
  const phase = taskPhase(task, entry);
  const expected = task.reviewDigest ?? task.digest;
  const readiness = context.index.taskReadiness;
  const transition = (state: TaskStatus, label: string) =>
    (state !== task.metadata.status ||
      state === "Accepted" ||
      (state === "Approved" && !!task.approval && !task.approval.current)) &&
    !taskTransitionProblem(task, readiness, state)
      ? mutationForm({
          action: Route.TaskState,
          context,
          csrf: context.csrf,
          fields: { reference: record.id, expected, state },
          children: () => submitButton(label, { secondary: state !== "Approved" && state !== "Accepted" }),
        })
      : null;
  const acceptOutcome = () => transition("Accepted", "Accept outcome");
  const operationURL = (kind: "cancel" | "delete" | "revert") =>
    sourceURL(
      context,
      routeURL(Route.TaskOperation, { id: record.id, kind, ...(context.workflow ? { workflow: "1" } : {}) }),
    );
  return (
    <section aria-label="Task actions" class="task-workflow">
      {task.approval?.source === "developer-requested-review" && <p class="muted">Review requested by the developer</p>}
      {entry && phase !== TaskPhase.Reviews && !terminalTask.has(record.status) && (
        <p>
          {badge(
            context.awaitingReapproval(record.id)
              ? "Plan changed"
              : entry.state === TaskExecution.Implemented && phase === TaskPhase.Work
                ? "Verification required"
                : entry.state,
          )}
          {entry.reason && <> {entry.reason}</>}
        </p>
      )}
      {task.approval && task.approval.files.length > 0 && (
        <ul aria-label="Supporting file changes">
          {task.approval.files.map((file) => (
            <li key={file.name}>
              {file.name}: {file.change}
            </li>
          ))}
        </ul>
      )}
      <div class="task-actions">
        {record.status === "Approved" &&
          !entry &&
          !task.implementation &&
          mutationForm({
            action: Route.QueueChange,
            context,
            csrf: context.csrf,
            fields: { operation: "add", reference: record.id, target: "", expected: queueDigest(queue) },
            children: () => submitButton("Add to local queue", { secondary: true }),
          })}
        {(record.status === "Planned" || (record.status === "Approved" && task.approval && !task.approval.current)) &&
          transition("Approved", record.status === "Approved" ? "Approve revised plan" : "Approve plan")}
        {phase === TaskPhase.Reviews && acceptOutcome()}
      </div>
      {(record.status !== "Planned" ||
        !!task.implementation ||
        !taskTransitionProblem(task, readiness, "Canceled")) && (
        <details>
          <summary>More task actions</summary>
          <div class="task-actions">
            {!terminalTask.has(record.status) && !taskTransitionProblem(task, readiness, "Canceled") && (
              <a class="button secondary" href={operationURL("cancel")}>
                Cancel task
              </a>
            )}
            {record.status !== "Planned" &&
              transition(
                "Planned",
                record.status === "Accepted" || record.status === "Canceled" ? "Reopen task" : "Return to planning",
              )}
            {(!!task.implementation ||
              (!!entry && entry.state !== TaskExecution.Queued) ||
              record.status === "Approved" ||
              record.status === "Accepted") && (
              <>
                <a class="button secondary" href={operationURL("delete")}>
                  Delete unpublished work
                </a>
                <a class="button secondary" href={operationURL("revert")}>
                  Revert work
                </a>
              </>
            )}
            {record.status === "Accepted" &&
              context.index.snapshot.tasks.decisionsRequired &&
              !task.acceptanceNeedsReview &&
              acceptOutcome()}
            {record.status === "Approved" && !entry && !task.implementation && acceptOutcome()}
          </div>
        </details>
      )}
    </section>
  );
}
