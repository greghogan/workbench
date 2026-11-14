import { workflowWindows, type WorkflowPhase } from "../routes/workflow-window.js";
import { taskTransitionProblem } from "../../core/tasks/task-service.js";
import { recordBatchSize, recordWindowLimit } from "../routes/record-window.js";
import { WebError } from "../http/errors.js";
import type { JSX } from "preact";
import { taskStatuses, terminalTask, type TaskStatus } from "../../core/records/record-document.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
import { queueDigest, TaskBlockerKind, TaskExecution } from "../../core/tasks/task-queue.js";
import type { ViewContext } from "../workspace/view-context.js";
import { recordList, timeTag } from "./record-content.js";
import { shell } from "./page-frame.js";
import { tabs, linkButton } from "./render-links.js";
import { sourceURL } from "../routes/sources.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { referenceLink } from "./record-links.js";
import { mutationForm } from "./action-forms.js";
import { submitButton, badge } from "./components.js";
import { Route, type RouteQuery, type QueueOperation } from "../routes/routes.js";

const taskOverviewOrder: readonly TaskStatus[] = ["Approved", "Planned", "Accepted", "Canceled"];

/** Workflow phases preserve parentage; a parent in another phase remains a contextual link. */
function taskList(
  context: ViewContext,
  records: BrowserRecord[],
  render: (record: BrowserRecord) => JSX.Element | null = (record) => recordList([record], context, 3),
): JSX.Element {
  const selected = records;
  if (context.index.snapshot.tasks.problem) return recordList(selected, context);
  const byId = new Map(selected.map((record) => [record.id, record]));
  const children = new Map<string, BrowserRecord[]>();
  const roots: BrowserRecord[] = [];
  for (const record of selected) {
    let parent = context.index.taskGraph.byReference.get(record.id)?.parent;
    while (parent && !byId.has(parent)) parent = context.index.taskGraph.byReference.get(parent)?.parent;
    if (parent) {
      const siblings = children.get(parent) ?? [];
      siblings.push(record);
      children.set(parent, siblings);
    } else roots.push(record);
  }
  const item = (record: BrowserRecord): JSX.Element => {
    const parentId = context.index.taskGraph.byReference.get(record.id)?.parent;
    const parent = parentId && !byId.has(parentId) ? context.index.byId.get(parentId) : undefined;
    const nested = children.get(record.id) ?? [];
    return (
      <li data-task-node={record.id} key={record.id}>
        {parent && <nav aria-label="Parent task">{referenceLink(parent, parent.title)}</nav>}
        {render(record)}
        {nested.length > 0 && <ul class="task-tree">{nested.map(item)}</ul>}
      </li>
    );
  };
  return (
    <ul class="task-tree" data-task-items="">
      {roots.map(item)}
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
  const pendingDocuments = context.index.snapshot.commitReviews.filter(
    (unit) => unit.taskPaths.includes(record.path) && unit.paths.length,
  );
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
  return (
    <section aria-label="Task actions" class="task-workflow">
      {entry && (
        <p>
          {badge(entry.state === TaskExecution.Implemented ? "Awaiting acceptance" : entry.state)}{" "}
          {entry.reason ?? entry.evidence}
        </p>
      )}
      {!entry && task.implementation && (
        <p>
          Implementation evidence at <code>{task.implementation.baseline.slice(0, 12)}</code> from{" "}
          <code>{task.implementation.checkout}</code> ({timeTag(task.implementation.verified)}):{" "}
          {task.implementation.evidence}
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
      {pendingDocuments.length > 0 && (
        <section aria-label="Pending document reviews">
          <h2>Pending document reviews</h2>
          <ul>
            {pendingDocuments.flatMap((unit) =>
              unit.paths.map((path) => (
                <li key={unit.revision + path}>
                  <a href={routeURL(Route.History, { commit: unit.revision, path, all: "1" })}>{path}</a>
                  {" · "}
                  {unit.subject}
                </li>
              )),
            )}
          </ul>
        </section>
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
        {record.status === "Approved" &&
          (entry?.state === TaskExecution.Implemented || (!entry && task.implementation)) &&
          transition("Accepted", "Accept outcome")}
      </div>
      {(record.status !== "Planned" ||
        !!task.implementation ||
        !taskTransitionProblem(task, readiness, "Canceled")) && (
        <details>
          <summary>More task actions</summary>
          <div class="task-actions">
            {!terminalTask.has(record.status) && !taskTransitionProblem(task, readiness, "Canceled") && (
              <a
                class="button secondary"
                href={routeURL(Route.TaskOperation, { id: record.id, kind: "cancel", scope: context.scope })}
              >
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
                <a
                  class="button secondary"
                  href={routeURL(Route.TaskOperation, { id: record.id, kind: "delete", scope: context.scope })}
                >
                  Delete unpublished work
                </a>
                <a
                  class="button secondary"
                  href={routeURL(Route.TaskOperation, { id: record.id, kind: "revert", scope: context.scope })}
                >
                  Revert work
                </a>
              </>
            )}
            {record.status === "Accepted" &&
              context.index.snapshot.tasks.decisionsRequired &&
              transition("Accepted", "Renew acceptance")}
            {record.status === "Approved" && !entry && !task.implementation && transition("Accepted", "Accept outcome")}
          </div>
        </details>
      )}
    </section>
  );
}

export function taskQueuePage(context: ViewContext, parameters: RouteQuery<typeof Route.TaskQueue> = {}): string {
  const pageWindows = workflowWindows(context, parameters);
  const window = <T,>(phase: WorkflowPhase, items: readonly T[], id: (item: T) => string) => {
    const result = pageWindows(phase, items, id);
    return {
      ...result,
      previous: result.previous ? (
        <a class="button secondary" href={result.previous}>
          Load previous
        </a>
      ) : null,
      loader: (
        <div data-task-loader="">
          {result.next && (
            <a class="button secondary" data-task-more="" href={result.next}>
              Load more
            </a>
          )}
        </div>
      ),
    };
  };

  const queue = context.taskQueue;
  const reviews = context.taskReviews;
  const plans = reviews.filter((item) => item.decision === "plan").map((item) => item.record);
  const outcomes = reviews.filter((item) => item.decision === "outcome").map((item) => item.record);
  const outcomeIds = new Set(outcomes.map((record) => record.id));
  const planIds = new Set(plans.map((record) => record.id));
  const work = queue.entries.filter(
    (entry) =>
      !outcomeIds.has(entry.reference) &&
      !planIds.has(entry.reference) &&
      entry.status !== "Planned" &&
      (!entry.status || !terminalTask.has(entry.status)),
  );
  plans.sort(
    (left, right) => (left.addedAt ?? "").localeCompare(right.addedAt ?? "") || left.id.localeCompare(right.id),
  );
  const planWindow = window("plans", plans, (record) => record.id),
    workWindow = window("work", work, (entry) => entry.reference),
    outcomeWindow = window("outcomes", outcomes, (record) => record.id);
  const selected = new Set(queue.entries.map((entry) => entry.reference));
  const available = context.workflowTasks.filter(
    (task) =>
      task.metadata.status === "Approved" &&
      !selected.has(task.reference) &&
      !outcomeIds.has(task.reference) &&
      !planIds.has(task.reference),
  );

  const availableWindow = window("available", available, (task) => task.reference);
  if (
    planWindow.visible.length +
      workWindow.visible.length +
      outcomeWindow.visible.length +
      availableWindow.visible.length >
    recordWindowLimit
  )
    throw new WebError(400, "Workflow window exceeds its limit; open the next page");
  const queueForm = (operation: QueueOperation, reference: string, children: JSX.Element, target = "") =>
    mutationForm({
      action: Route.QueueChange,
      context,
      csrf: context.csrf,
      fields: { operation, reference, target, expected: queue.digest },
      children: () => children,
    });
  const action = (operation: QueueOperation, reference: string, label: string, target = "") =>
    queueForm(
      operation,
      reference,
      submitButton(label, { secondary: true, id: `queue-${operation}-${reference}` }),
      target,
    );
  const orderControls = (
    reference: string,
    title: string,
    before: string | undefined,
    after: string | undefined,
    removable: boolean,
  ) => {
    const control = (operation: QueueOperation, glyph: string, label: string, disabled: boolean, target = "") =>
      queueForm(
        operation,
        reference,
        <button
          type="submit"
          class="secondary icon-button"
          id={`queue-${operation}-${reference}`}
          aria-label={`${label}: ${title}`}
          title={`${label}: ${title}`}
          disabled={disabled}
        >
          <span aria-hidden="true">{glyph}</span>
        </button>,
        target,
      );
    return (
      <fieldset class="task-queue-controls">
        <legend class="sr-only">Queue controls: {title}</legend>
        {control("move-before", "↑", "Move up", !before, before)}
        {control("remove", "×", "Remove from queue", !removable)}
        {control("move-after", "↓", "Move down", !after, after)}
      </fieldset>
    );
  };
  return shell(
    context,
    "Task workflow",
    "queue",
    <>
      <section aria-label="Plans">
        <h2>Plans</h2>
        <div
          data-task-window={planWindow.key}
          data-task-through={planWindow.through}
          data-list-revision={context.revision}
        >
          {planWindow.previous}
          {plans.length ? (
            taskList(context, [...planWindow.visible], (record) => recordList([record], context, 3))
          ) : (
            <p>No plans awaiting approval.</p>
          )}
          {planWindow.loader}
        </div>
      </section>
      <section aria-label="Work">
        <h2>Work</h2>
        {work.length === 0 && <p>No tasks selected for implementation.</p>}
        <div
          data-task-window={workWindow.key}
          data-task-through={workWindow.through}
          data-list-revision={context.revision}
        >
          {workWindow.previous}
          <ol class="task-queue" data-task-items="">
            {workWindow.visible.map((entry) => {
              const index = work.findIndex((item) => item.reference === entry.reference);
              const task = context.index.taskGraph.byReference.get(entry.reference),
                blockers = task
                  ? context.index.taskReadiness
                      .blockers(task)
                      .filter((blocker) => blocker.kind !== TaskBlockerKind.Active)
                      .map((blocker) => blocker.message)
                  : entry.blockers;
              return (
                <li key={entry.reference} data-task-node={entry.reference} class="task-queue-row">
                  {orderControls(
                    entry.reference,
                    entry.title,
                    work[index - 1]?.reference,
                    work[index + 1]?.reference,
                    entry.state !== TaskExecution.Active,
                  )}
                  <div class="task-queue-content">
                    <h3>
                      <a href={recordURL(entry.reference)}>{entry.title}</a>
                    </h3>
                    <p>
                      {badge(entry.status ?? "Missing")}{" "}
                      {badge(entry.state === TaskExecution.Implemented ? "Awaiting acceptance" : entry.state)}{" "}
                      {queue.ready.includes(entry.reference) && badge("Ready")}
                    </p>
                    {blockers.length > 0 && (
                      <ul>
                        {blockers.map((reason) => (
                          <li>{reason}</li>
                        ))}
                      </ul>
                    )}
                    {entry.evidence && <p>{entry.evidence}</p>}
                    {entry.state === TaskExecution.Implemented && entry.status !== "Accepted" && (
                      <div class="task-actions">{linkButton("Review outcome", recordURL(entry.reference), true)}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {workWindow.loader}
        </div>
        <div
          data-task-window={availableWindow.key}
          data-task-through={availableWindow.through}
          data-list-revision={context.revision}
        >
          {availableWindow.previous}
          {taskList(
            context,
            availableWindow.visible.flatMap((task) => {
              const record = context.index.byId.get(task.reference);
              return record ? [record] : [];
            }),
            (record) => {
              const task = context.index.taskGraph.byReference.get(record.id);
              if (!task) return null;
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
            },
          )}
          {availableWindow.loader}
        </div>
        {context.experimentWorkflow.some((item) => item.phase === "work") && (
          <section aria-label="Experiments">
            <h2>Experiments</h2>
            {recordList(
              context.experimentWorkflow
                .filter((item) => item.phase === "work")
                .map((item) => item.record)
                .slice(0, recordBatchSize),
              context,
            )}
          </section>
        )}
      </section>
      <section aria-label="Outcomes">
        <h2>Outcomes</h2>
        <div
          data-task-window={outcomeWindow.key}
          data-task-through={outcomeWindow.through}
          data-list-revision={context.revision}
        >
          {outcomeWindow.previous}
          {outcomes.length ? taskList(context, [...outcomeWindow.visible]) : <p>No outcomes awaiting acceptance.</p>}
          {outcomeWindow.loader}
        </div>
      </section>
    </>,
  );
}
