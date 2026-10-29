import { taskTransitionProblem } from "../task-service.js";
import { recordBatchSize, recordWindowLimit } from "./record-window.js";
import { WebError } from "./errors.js";
import type { JSX } from "preact";
import { taskStatuses, terminalTask, type TaskStatus } from "../record-document.js";
import type { BrowserRecord } from "../record-service.js";
import { queueDigest, TaskExecution } from "../task-queue.js";
import type { ViewContext } from "./view-context.js";
import { recordList } from "./record-content.js";
import { shell } from "./page-frame.js";
import { tabs, linkButton } from "./render-links.js";
import { sourceURL } from "./sources.js";
import { recordURL } from "./locations.js";
import { referenceLink } from "./record-links.js";
import { mutationForm } from "./action-forms.js";
import { submitButton, badge } from "./components.js";
import { Route, type RouteQuery, type QueueOperation } from "./routes.js";

const taskOverviewOrder: readonly TaskStatus[] = ["Approved", "Planned", "Accepted", "Canceled"];

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
  let windows: Record<string, string> = {};
  if (parameters.task_windows) {
    try {
      const input: unknown = JSON.parse(parameters.task_windows);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.values(input).some((value) => typeof value !== "string") ||
        Object.keys(input).length > recordWindowLimit
      )
        throw new Error("Invalid task windows");
      windows = input as Record<string, string>;
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
  const url = (values: Record<string, string>) => {
    const query = new URLSearchParams({ type: "TSK", ...values, ...(parent ? { parent: parent.reference } : {}) });
    return sourceURL(context, "/records?" + query.toString());
  };
  const item = (task: (typeof tasks)[number]): JSX.Element | null => {
    if (++displayed > recordWindowLimit)
      throw new WebError(400, "Task tree window exceeds its limit; collapse branches or open the next task view");
    const record = byId.get(task.reference);
    if (!record) return null;
    const children = prepared.problem
      ? []
      : (context.index.taskGraph.children.get(task.reference) ?? []).filter((child) => byId.has(child.reference));
    const last = windows[task.reference];
    const through = last ? children.findIndex((child) => child.reference === last) + 1 : 0;
    if (last && !through) throw new WebError(409, "Task branch changed; refresh the tree");
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
          <details data-task-branch={task.reference} open={Object.hasOwn(windows, task.reference)}>
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
    !taskStatuses.some((state) => state === record.status)
  )
    return null;
  const queue = context.index.snapshot.tasks.queue,
    entry = queue.entries.find((entry) => entry.reference === record.id);
  if (context.index.snapshot.tasks.problem) return <p class="notice">{context.index.snapshot.tasks.problem}</p>;
  const task = context.index.taskGraph.byReference.get(record.id);
  if (!task) return null;
  const expected = task.digest;
  const readiness = context.index.taskReadiness;
  const transition = (state: TaskStatus, label: string) =>
    (state !== task.metadata.status || state === "Accepted") && !taskTransitionProblem(task, readiness, state)
      ? mutationForm({
          action: Route.TaskState,
          context,
          csrf: context.csrf,
          fields: { reference: record.id, expected, state },
          children: () => submitButton(label),
        })
      : null;
  return (
    <section aria-label="Task workflow" class="task-workflow">
      <h2>Task workflow</h2>
      {entry && (
        <p>
          {badge(entry.state)} {entry.reason ?? entry.evidence}
        </p>
      )}
      {record.status === "Planned" && transition("Approved", "Approve plan")}
      {record.status === "Approved" &&
        (!entry || entry.state === TaskExecution.Implemented) &&
        transition("Accepted", "Accept outcome")}
      {record.status === "Accepted" &&
        context.index.snapshot.tasks.decisionsRequired &&
        transition("Accepted", "Renew acceptance")}
      {record.status === "Approved" &&
        !entry &&
        mutationForm({
          action: Route.QueueChange,
          context,
          csrf: context.csrf,
          fields: { operation: "add", reference: record.id, target: "", expected: queueDigest(queue) },
          children: () => submitButton("Add to local queue"),
        })}
      {record.status !== "Planned" && transition("Planned", "Return to planning")}
      {!terminalTask.has(record.status) && transition("Canceled", "Cancel task")}
      {linkButton("Task queue", Route.TaskQueue, true)}
    </section>
  );
}

export function taskQueuePage(context: ViewContext): string {
  const queue = context.index.taskQueue;
  const reviews = context.taskReviews;
  const plans = reviews.filter((item) => item.decision === "plan").map((item) => item.record);
  const outcomes = reviews.filter((item) => item.decision === "outcome").map((item) => item.record);
  const outcomeIds = new Set(outcomes.map((record) => record.id));
  const work = queue.entries.filter(
    (entry) => !outcomeIds.has(entry.reference) && (!entry.status || !terminalTask.has(entry.status)),
  );
  const selected = new Set(queue.entries.map((entry) => entry.reference));
  const available = context.index.taskGraph.tasks.filter(
    (task) => task.metadata.status === "Approved" && !selected.has(task.reference),
  );

  const action = (operation: QueueOperation, reference: string, label: string, target = "") =>
    mutationForm({
      action: Route.QueueChange,
      context,
      csrf: context.csrf,
      fields: { operation, reference, target, expected: queue.digest },
      children: () => submitButton(label, { secondary: true, id: `queue-${operation}-${reference}` }),
    });
  return shell(
    context,
    "Task workflow",
    "queue",
    <>
      <section aria-label="Plans">
        <h2>Plans</h2>
        {plans.length ? recordList(plans.slice(0, recordBatchSize), context) : <p>No plans awaiting approval.</p>}
        {plans.length > recordBatchSize &&
          linkButton("Browse all planned tasks", sourceURL(context, "/records?type=TSK&status=Planned"), true)}
      </section>
      <section aria-label="Work">
        <h2>Work</h2>
        {work.length === 0 && <p>No tasks selected for implementation.</p>}
        <ol class="task-queue">
          {work.map((entry, index) => (
            <li key={entry.reference}>
              <h3>
                <a href={recordURL(entry.reference)}>{entry.title}</a>
              </h3>
              <p>
                {badge(entry.status ?? "Missing")} {badge(entry.state)}{" "}
                {queue.ready.includes(entry.reference) && badge("Ready")}
              </p>
              {entry.blockers.length > 0 && (
                <ul>
                  {entry.blockers.map((reason) => (
                    <li>{reason}</li>
                  ))}
                </ul>
              )}
              {entry.evidence && <p>{entry.evidence}</p>}
              <div class="task-actions">
                {index > 0 && action("move-before", entry.reference, "Move up", work[index - 1]?.reference)}
                {index + 1 < work.length &&
                  action("move-after", entry.reference, "Move down", work[index + 1]?.reference)}
                {queue.ready.includes(entry.reference) && action("start", entry.reference, "Start task")}
                {entry.state !== TaskExecution.Active && action("remove", entry.reference, "Remove from queue")}
                {entry.state !== TaskExecution.Queued && action("release", entry.reference, "Return to queue")}
                {entry.state === TaskExecution.Implemented &&
                  entry.status !== "Accepted" &&
                  linkButton("Review outcome", recordURL(entry.reference), true)}
              </div>
              {(entry.state === TaskExecution.Active || entry.state === TaskExecution.Queued) &&
                mutationForm({
                  action: Route.QueueChange,
                  context,
                  csrf: context.csrf,
                  fields: { operation: "block", reference: entry.reference, target: "", expected: queue.digest },
                  children: (fields) => (
                    <>
                      {fields.text("detail", {
                        id: `block-${entry.reference}`,
                        label: "Blocking reason",
                        required: true,
                        maxLength: 16384,
                      })}
                      {submitButton("Mark blocked", { secondary: true })}
                    </>
                  ),
                })}
              {entry.state === TaskExecution.Active &&
                mutationForm({
                  action: Route.QueueChange,
                  context,
                  csrf: context.csrf,
                  fields: { operation: "implemented", reference: entry.reference, target: "", expected: queue.digest },
                  children: (fields) => (
                    <>
                      {fields.text("detail", {
                        id: `evidence-${entry.reference}`,
                        label: "Verification and outcome",
                        required: true,
                        maxLength: 16384,
                      })}
                      {submitButton("Report implemented")}
                    </>
                  ),
                })}
            </li>
          ))}
        </ol>
        {available.slice(0, recordBatchSize).map((task) => {
          const record = context.index.byId.get(task.reference);
          if (!record) return null;
          const blockers = context.index.taskReadiness.blockers(task);
          return (
            <article key={task.reference}>
              <h3>{referenceLink(record, record.title)}</h3>
              {badge(blockers.length ? "Waiting on prerequisites" : "Ready")}
              {blockers.length > 0 && (
                <ul>
                  {blockers.map((blocker) => (
                    <li>{blocker.message}</li>
                  ))}
                </ul>
              )}
              {action("add", task.reference, "Add to local queue")}
            </article>
          );
        })}
        {available.length > recordBatchSize &&
          linkButton("Browse all approved tasks", sourceURL(context, "/records?type=TSK&status=Approved"), true)}
      </section>
      <section aria-label="Outcomes">
        <h2>Outcomes</h2>
        {outcomes.length ? (
          recordList(outcomes.slice(0, recordBatchSize), context)
        ) : (
          <p>No outcomes awaiting acceptance.</p>
        )}
        {outcomes.length > recordBatchSize &&
          linkButton("Browse all approved tasks", sourceURL(context, "/records?type=TSK&status=Approved"), true)}
      </section>
    </>,
  );
}
