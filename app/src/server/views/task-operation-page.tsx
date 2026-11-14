import { WebError } from "../http/errors.js";
import { taskDisposition } from "../../core/tasks/task-disposition.js";
import { taskTransitionProblem } from "../../core/tasks/task-service.js";
import { shell } from "./page-frame.js";
import { mutationForm } from "./action-forms.js";
import { confirmationActions } from "./components.js";
import { routeURL, recordURL } from "../routes/locations.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import type { ViewContext } from "../workspace/view-context.js";
export function taskOperationPage(context: ViewContext, query: RouteQuery<typeof Route.TaskOperation>): string {
  if (!query.id || !query.kind) throw new WebError(400, "Select a task and operation");
  const id = query.id,
    kind = query.kind,
    back = recordURL(id),
    task = context.index.taskGraph.byReference.get(id);
  if (!task || task.archived) throw new WebError(404, "Task not found");
  if (kind === "cancel") {
    const problem = taskTransitionProblem(task, context.index.taskReadiness, "Canceled");
    if (task.metadata.status === "Canceled" || problem) throw new WebError(409, problem ?? "Task is already canceled");
    return shell(
      context,
      "Cancel task",
      "queue",
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
    );
  }
  if (kind === "revert" && !query.reason)
    return shell(
      context,
      "Revert task work",
      "queue",
      <form method="get" action={routeURL(Route.TaskOperation, { id, kind })} class="form-grid">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="kind" value="revert" />
        <input type="hidden" name="scope" value={context.scope} />
        <div class="field">
          <label for="revert-reason">Reason</label>
          <textarea id="revert-reason" name="reason" required maxLength={16384} rows={3} />
        </div>
        {confirmationActions("Preview inverse changes", back)}
      </form>,
    );
  const plan = taskDisposition(context.root, id, kind, query.reason);
  return shell(
    context,
    kind === "delete" ? "Delete unpublished task work" : "Revert task work",
    "queue",
    <>
      <ul>
        {plan.commits.map((revision) => (
          <li key={revision}>
            <a href={routeURL(Route.History, { commit: revision })}>{revision.slice(0, 12)}</a>
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
  );
}
