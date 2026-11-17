import type { JSX } from "preact";
import type { BrowserRecord } from "../../core/records/record-service.js";
import { TaskBlockerKind, taskStarted } from "../../core/tasks/task-queue.js";
import { workflowWindows, type WorkflowPhase, type WorkflowRoute } from "../routes/workflow-window.js";
import { Route, type WorkflowQuery, type QueueOperation } from "../routes/routes.js";
import type { ViewContext } from "../workspace/view-context.js";
import { workflowRecordURL } from "../review/review-navigation.js";
import { shell } from "./page-frame.js";
import { recordList } from "./record-content.js";
import { taskList } from "./task-pages.js";
import { referenceLink } from "./record-links.js";
import { mutationForm } from "./action-forms.js";
import { badge } from "./components.js";
import { workflowUpdates } from "../workspace/workflow-updates.js";
import { normalizedNumber } from "../../core/records/record-identity.js";

function blockerText(context: ViewContext, message: string, scope?: string) {
  const references = /\b(?:([a-z][a-z0-9_-]*):)?(ADR|TSK|EXP|ENV)-([0-9A-Z]+)\b/g;
  const parts = [];
  let offset = 0;
  for (const match of message.matchAll(references)) {
    const [value, namespace, kind, number] = match;
    const owner = namespace ?? scope;
    if (!value || !owner || !kind || !number) continue;
    const record = context.index.byId.get(`${owner}:${kind}-${normalizedNumber(number)}`);
    if (!record) continue;
    parts.push(message.slice(offset, match.index), referenceLink(record, value));
    offset = match.index + value.length;
  }
  return [...parts, message.slice(offset)];
}

export function workflowWindow(context: ViewContext, parameters: WorkflowQuery, route: WorkflowRoute) {
  const view = route === Route.Plans ? "plans" : route === Route.Work ? "work" : "reviews";
  const revision = workflowUpdates(context, view).key;
  const { scope, selection, all } = context;
  const page = workflowWindows({ scope, selection, all, revision }, parameters, route);
  return <T,>(phase: WorkflowPhase, items: readonly T[], id: (item: T) => string) => {
    const result = page(phase, items, id);
    return {
      ...result,
      revision,
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
}
function windowList(
  context: ViewContext,
  window: {
    key: string;
    through: string | undefined;
    revision: string;
    previous: JSX.Element | null;
    loader: JSX.Element;
  },
  records: BrowserRecord[],
  headingLevel: 2 | 3 = 3,
) {
  return (
    <div data-task-window={window.key} data-task-through={window.through} data-list-revision={window.revision}>
      {window.previous}
      {taskList(context, records, (record) =>
        recordList([record], context, headingLevel, (item) => workflowRecordURL(context, item.id)),
      )}
      {window.loader}
    </div>
  );
}
export function plansPage(context: ViewContext, parameters: WorkflowQuery = {}): string {
  const plans = context.workflowPlans;
  const window = workflowWindow(context, parameters, Route.Plans)("plans", plans, (record) => record.id);
  return shell(
    context,
    "Plans",
    "plans",
    <>
      {context.index.snapshot.tasks.problem && <p class="notice">{context.index.snapshot.tasks.problem}</p>}
      {plans.length ? (
        windowList(context, window, [...window.visible], 2)
      ) : (
        <p class="empty">No plans awaiting approval.</p>
      )}
      <output id="task-loading-status" class="sr-only"></output>
    </>,
    { workflowList: "plans" },
  );
}
export function workPage(context: ViewContext, parameters: WorkflowQuery = {}): string {
  const window = workflowWindow(context, parameters, Route.Work),
    queue = context.taskQueue;
  const workIds = new Set(context.workflowWork.map((task) => task.reference));
  const work = queue.entries.filter((entry) => workIds.has(entry.reference));
  const workWindow = window("work", work, (entry) => entry.reference);
  const queueForm = (operation: QueueOperation, reference: string, children: JSX.Element, target = "") =>
    mutationForm({
      action: Route.QueueChange,
      context,
      csrf: context.csrf,
      fields: { operation, reference, target, expected: queue.digest },
      children: () => children,
    });
  const orderControls = (reference: string, title: string, before: string | undefined, after: string | undefined) => {
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
        {control("move-after", "↓", "Move down", !after, after)}
      </fieldset>
    );
  };
  return shell(
    context,
    "Work",
    "work",
    <>
      {context.index.snapshot.tasks.problem && <p class="notice">{context.index.snapshot.tasks.problem}</p>}
      {context.workCount === 0 && <p class="empty">No approved work.</p>}
      {work.length > 0 && (
        <section aria-label="Queued work">
          <h2>Queued work</h2>
          <div
            data-task-window={workWindow.key}
            data-task-through={workWindow.through}
            data-list-revision={workWindow.revision}
          >
            {workWindow.previous}
            <ol class="task-queue" data-task-items="">
              {workWindow.visible.map((entry) => {
                const index = work.findIndex((item) => item.reference === entry.reference);
                const task = context.index.taskGraph.require(entry.reference);
                const blockers = context.index.taskReadiness
                  .blockers(task)
                  .filter((blocker) => blocker.kind !== TaskBlockerKind.Active);
                const status = context.taskState(entry.reference);
                return (
                  <li key={entry.reference} data-task-node={entry.reference} class="task-queue-row">
                    {orderControls(
                      entry.reference,
                      entry.title,
                      work[index - 1]?.reference,
                      work[index + 1]?.reference,
                    )}
                    <div class="task-queue-content">
                      {badge(entry.reference)}
                      <h3>
                        <a href={workflowRecordURL(context, entry.reference)}>{entry.title}</a>
                      </h3>
                      <p>
                        {status && badge(status)}{" "}
                        {blockers.some((blocker) => blocker.kind !== TaskBlockerKind.Verification) && badge("Blocked")}{" "}
                        {queue.ready.includes(entry.reference) &&
                          badge(taskStarted(entry) ? "Ready to resume" : "Ready")}
                      </p>
                      {blockers.length > 0 && (
                        <ul>
                          {blockers.map((reason) => (
                            <li>{blockerText(context, reason.message, entry.reference.split(":")[0])}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {workWindow.loader}
          </div>
        </section>
      )}
      <output id="task-loading-status" class="sr-only"></output>
    </>,
    { workflowList: "work" },
  );
}
