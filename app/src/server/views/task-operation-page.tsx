import { WebError } from "../http/errors.js";
import { previewTaskDisposition } from "../../core/tasks/task-disposition.js";
import { taskRecordTrail } from "./workflow-navigation.js";
import { taskTransitionProblem } from "../../core/tasks/task-service.js";
import { shell } from "./page-frame.js";
import { mutationForm } from "./action-forms.js";
import { confirmationActions } from "./components.js";
import { routeURL } from "../routes/locations.js";
import { gitBytes } from "../../core/git/git-snapshot.js";
import { taskHadApproval } from "../../core/tasks/task-workflow.js";
import { sourceURL } from "../routes/sources.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import type { ViewContext } from "../workspace/view-context.js";
export async function taskOperationPage(
  context: ViewContext,
  query: RouteQuery<typeof Route.TaskOperation>,
): Promise<string> {
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
  const choiceURL = (options: Partial<RouteQuery<typeof Route.TaskOperation>>) =>
    sourceURL(
      context,
      routeURL(Route.TaskOperation, {
        id,
        kind,
        ...(context.workflow ? { workflow: "1" } : {}),
        ...(query.reason ? { reason: query.reason } : {}),
        ...options,
      }),
    );
  if (kind === "delete-plan") {
    return shell(
      context,
      "Delete plan",
      active,
      <>
        <p>{task.title}</p>
        {mutationForm({
          action: Route.TaskDisposition,
          context,
          csrf: context.csrf,
          fields: { reference: id, expected: task.reviewDigest ?? task.digest, kind, reason: "" },
          children: () => confirmationActions("Delete plan", back),
        })}
      </>,
      { parents },
    );
  }
  if (kind === "cancel") {
    const problem = taskTransitionProblem(task, context.index.taskReadiness, "Canceled");
    if (task.metadata.status === "Canceled" || problem) throw new WebError(409, problem ?? "Task is already canceled");
    const entry = context.index.taskReadiness.entries.get(id);
    const label = taskHadApproval(task, entry) ? "Cancel task" : "Cancel plan";
    if (context.taskHasDelivery(id))
      return shell(
        context,
        label,
        active,
        <form method="get" action={routeURL(Route.TaskOperation, { id, kind })} class="form-grid task-cancel">
          <input type="hidden" name="id" value={id} />
          {context.workflow && <input type="hidden" name="workflow" value="1" />}
          {context.all ? (
            <input type="hidden" name="all" value="1" />
          ) : (
            <input type="hidden" name="scope" value={context.scope} />
          )}
          <p>{task.title}</p>
          <p>Choose how to undo this task’s commits.</p>
          <div class="field">
            <label for="task-cancellation">Reason (optional)</label>
            <textarea name="reason" id="task-cancellation" maxLength={2000} rows={2}>
              {query.reason ?? ""}
            </textarea>
          </div>
          <div class="confirmation-actions">
            <button name="kind" value="cancel-remove" class="secondary">
              Remove task commits
            </button>
            <button name="kind" value="cancel-revert" class="secondary">
              Revert with a new commit
            </button>
          </div>
          <a href={back}>Back</a>
        </form>,
        { parents },
      );
    return shell(
      context,
      label,
      active,
      <>
        <p>{task.title}</p>
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
  const plan = await previewTaskDisposition(context.root, id, kind, query.reason);
  const canceling = kind === "cancel-remove" || kind === "cancel-revert";
  const backLink = canceling ? choiceURL({ kind: "cancel" }) : back;
  const published = !!plan.publication?.affected.length;
  const uncertain = !!plan.publication?.unknown.length;
  const selected = query.file && plan.updates.find((update) => update.path === query.file);
  const change = selected
    ? gitBytes(context.root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        plan.head,
        plan.tree,
        "--",
        selected.path,
      ]).toString()
    : "";
  const title =
    kind === "delete"
      ? "Delete unpublished task work"
      : kind === "cancel-remove"
        ? "Remove task commits"
        : kind === "cancel-revert"
          ? "Revert with a new commit"
          : "Revert task work";
  const confirmation =
    kind === "delete"
      ? "Confirm deletion"
      : kind === "cancel-remove" && published
        ? "Remove published commits locally"
        : kind === "cancel-remove"
          ? "Remove task commits locally"
          : kind === "cancel-revert"
            ? "Confirm reversion"
            : "Stage inverse changes";
  return shell(
    context,
    title,
    active,
    <>
      {published && (
        <div class="notice">
          <p>Removing these commits will change only the local branch. Published refs stay in place.</p>
          <ul>
            {plan.publication?.affected.map(([ref, oid]) => (
              <li>
                {ref} <code>{oid.slice(0, 12)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {uncertain && <p class="notice">Publication could not be verified on {plan.publication?.unknown.join(", ")}.</p>}
      {kind === "cancel-remove" && plan.base && (
        <dl>
          <dt>Local {plan.branch}</dt>
          <dd>
            <code>{plan.head.slice(0, 12)}</code>
          </dd>
          <dt>Base for the canceled record</dt>
          <dd>
            <code>{plan.base.slice(0, 12)}</code>
          </dd>
        </dl>
      )}
      <h2>Affected commits</h2>
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
      <h2>Affected files</h2>
      <ul>
        {plan.updates.map((file) => (
          <li key={file.path}>
            <a href={choiceURL({ file: file.path })}>{file.path}</a>
          </li>
        ))}
      </ul>
      {selected && <pre class="source">{change}</pre>}
      {plan.problems.length ? (
        <>
          <ul>
            {plan.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <a class="button secondary" href={backLink}>
            Back
          </a>
        </>
      ) : (
        <>
          <p>
            {kind === "delete"
              ? "Remove these unpublished commits from this branch. A recovery reference preserves the original history."
              : kind === "revert"
                ? "Stage the inverse change and retain the task account. Verify the revised outcome, then review and commit normally."
                : "This records the cancellation on the local branch."}
          </p>
          {mutationForm({
            action: Route.TaskDisposition,
            context,
            csrf: context.csrf,
            class: "task-cancel",
            fields: {
              reference: id,
              expected: plan.digest,
              kind,
              reason: query.reason ?? "",
              ...(published || uncertain ? { confirmPublished: "1" as const } : {}),
            },
            children: () => confirmationActions(confirmation, backLink),
          })}
        </>
      )}
    </>,
    { parents },
  );
}
