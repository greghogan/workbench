import { WebError } from "../http/errors.js";
import { taskDisposition } from "../../core/tasks/task-disposition.js";
import { taskRecordTrail } from "./workflow-navigation.js";
import { taskTransitionProblem } from "../../core/tasks/task-service.js";
import { shell } from "./page-frame.js";
import { mutationForm } from "./action-forms.js";
import { confirmationActions } from "./components.js";
import { routeURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import type { ViewContext } from "../workspace/view-context.js";
export function taskOperationPage(context: ViewContext, query: RouteQuery<typeof Route.TaskOperation>): string {
  if (!query.id || !query.kind) throw new WebError(400, "Select a task and operation");
  const id = query.id,
    kind = query.kind,
    task = context.index.taskGraph.byReference.get(id);
  if (!task || task.archived) throw new WebError(404, "Task not found");
  const {
    active,
    parents,
    href: back,
  } = taskRecordTrail(context, {
    id,
    title: context.index.byId.get(id)?.title ?? task.title,
  });
  if (kind === "cancel") {
    const problem = taskTransitionProblem(task, context.index.taskReadiness, "Canceled");
    if (task.metadata.status === "Canceled" || problem) throw new WebError(409, problem ?? "Task is already canceled");
    return shell(
      context,
      "Cancel task",
      active,
      <>
        <p>{task.title}</p>
        <p>Cancel the remaining work. Existing implementation and history are preserved.</p>
        {mutationForm({
          action: Route.TaskState,
          context,
          csrf: context.csrf,
          class: "form-grid task-cancel",
          fields: { reference: id, expected: task.reviewDigest ?? task.digest, state: "Canceled" },
          children: (controls) => (
            <>
              {controls.area("reason", {
                id: "task-cancellation",
                label: "Reason (optional)",
                value: "",
                required: false,
                maxLength: 16384,
              })}
              {confirmationActions("Confirm cancellation", back)}
            </>
          ),
        })}
      </>,
      { parents },
    );
  }
  if (kind === "revert" && !query.reason)
    return shell(
      context,
      "Revert task work",
      active,
      <form method="get" action={routeURL(Route.TaskOperation, { id, kind })} class="form-grid">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="kind" value="revert" />
        {context.workflow && <input type="hidden" name="workflow" value="1" />}
        {context.all ? (
          <input type="hidden" name="all" value="1" />
        ) : (
          <input type="hidden" name="scope" value={context.scope} />
        )}
        <div class="field">
          <label for="revert-reason">Reason</label>
          <textarea id="revert-reason" name="reason" required maxLength={16384} rows={3} />
        </div>
        {confirmationActions("Preview inverse changes", back)}
      </form>,
      { parents },
    );
  const plan = taskDisposition(context.root, id, kind, query.reason);
  return shell(
    context,
    kind === "delete" ? "Delete unpublished task work" : "Revert task work",
    active,
    <>
      <ul>
        {plan.commits.map((revision) => (
          <li key={revision}>
            <a
              href={sourceURL(
                context,
                routeURL(Route.TaskHistory, {
                  id,
                  commit: revision,
                  tip: revision,
                  ...(context.workflow ? { workflow: "1" } : {}),
                }),
              )}
            >
              {revision.slice(0, 12)}
            </a>
          </li>
        ))}
      </ul>
      <ul>
        {plan.updates.map((file) => (
          <li key={file.path}>{file.path}</li>
        ))}
      </ul>
      {plan.problems.length ? (
        <>
          <ul>
            {plan.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <a class="button secondary" href={back}>
            Back
          </a>
        </>
      ) : (
        <>
          <p>
            {kind === "delete"
              ? "Remove these unpublished commits from this branch. A recovery reference preserves the original history."
              : "Stage the inverse change and retain the task account. Verify the revised outcome, then review and commit normally."}
          </p>
          {mutationForm({
            action: Route.TaskDisposition,
            context,
            csrf: context.csrf,
            class: "task-cancel",
            fields: { reference: id, expected: plan.digest, kind, reason: query.reason ?? "" },
            children: () => confirmationActions(kind === "delete" ? "Confirm deletion" : "Stage inverse changes", back),
          })}
        </>
      )}
    </>,
    { parents },
  );
}
