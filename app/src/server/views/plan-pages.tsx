import { recordPane } from "./record-pane.js";
import { taskWorkflowNavigation, workflowParent } from "./workflow-navigation.js";
import { sourceQuery, sourceURL } from "../routes/sources.js";
import { planDeletion } from "../../core/tasks/planning/plan-disposition.js";
import type { ComponentChildren } from "preact";
import { planningPaths, parsePlanReference } from "../../core/tasks/planning/plan-model.js";
import { WebError } from "../http/errors.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import { DifferenceLayout, differenceLayout } from "../routes/navigation-state.js";
import { shell } from "./page-frame.js";
import { badge, panel, submitButton, confirmationActions } from "./components.js";
import { mutationForm } from "./action-forms.js";
import { linkButton, diffLayout } from "./render-links.js";
import { markdown } from "./markdown-view.js";
import { sourceDiffView } from "./diff-view.js";
import { addedAtTag, recordStatus } from "./record-content.js";
import { taskDecisionActions } from "./task-decision-actions.js";
import { TaskLifecycle } from "../../core/tasks/task-workflow.js";
import { reviewPreparationForm } from "./review-page.js";
import { PreparationState } from "../review/review-state.js";
import type { ViewContext } from "../workspace/view-context.js";
import { isSvg } from "../documents/document-image.js";
import type { PlanningRecord } from "../../core/tasks/planning/planning-read-model.js";

const attachmentBlobs = (files: PlanningRecord["files"]) => new Map(files.map(({ name, oid }) => [name, oid]));

export function planPage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Plan>,
  draft?: { contents: string; expected: string; error: string },
): string {
  const plan = context.index.snapshot.tasks.plans.find((plan) => plan.reference === parameters.id);
  if (!plan) throw new WebError(404, "Plan not found");
  if (plan.implementation && parameters.view === "edit")
    throw new WebError(409, "Edit the implementation task; this saved plan is read only");
  const location = (values: Omit<RouteQuery<typeof Route.Plan>, "id"> = {}) =>
    sourceURL(context, routeURL(Route.Plan, { id: plan.reference, ...values }));
  const back = location();
  const navigation = taskWorkflowNavigation(context, plan.reference);
  const state = context.taskState(plan.reference);
  const active = navigation.active ?? "plans";
  const planActions = !plan.approval;
  const cancelLabel = planActions ? "Cancel plan" : "Cancel task";
  const workflow = navigation.phase ? navigation.parents : [workflowParent(context, Route.Plans)];
  const parents = [...workflow, { label: plan.title, href: back }];
  if (parameters.view === "cancel") {
    if (plan.implementation || plan.status === "Canceled" || plan.problem || plan.conflict)
      throw new WebError(409, "This plan cannot be canceled in its current state");
    return shell(
      context,
      cancelLabel,
      active,
      <>
        <p>{plan.title}</p>
        {mutationForm({
          action: Route.PlanCancel,
          context,
          csrf: context.csrf,
          class: "form-grid task-cancel",
          fields: { reference: plan.reference, expected: plan.digest },
          children: (controls) => (
            <>
              {controls.area("reason", {
                id: "plan-cancellation",
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
  if (parameters.view === "delete") {
    const proposal = planDeletion(context.root, parsePlanReference(plan.reference));
    return shell(
      context,
      "Delete plan",
      active,
      <>
        <p>{proposal.title}</p>
        <ul>
          {proposal.files
            .filter((path) => path === planningPaths.document || path.startsWith(planningPaths.files))
            .map((path) => (
              <li key={path}>{path}</li>
            ))}
        </ul>
        {proposal.problems.length ? (
          <ul>
            {proposal.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : (
          mutationForm({
            action: Route.PlanDelete,
            context,
            csrf: context.csrf,
            class: "task-cancel",
            fields: { reference: plan.reference, expected: proposal.digest },
            children: () => confirmationActions("Confirm deletion", back),
          })
        )}
        {proposal.problems.length > 0 && linkButton("Back", back, true)}
      </>,
      { parents },
    );
  }
  const changed = !!plan.approval && (plan.approval.contents !== plan.contents || plan.changedFiles.length > 0);
  const indexedPath = context.index.byId.get(plan.reference)?.path;
  const needsPreparation =
    indexedPath !== undefined &&
    context.index.snapshot.reviewPreparation.files.get(indexedPath)?.state === PreparationState.Required;
  const view = parameters.view ?? (changed ? "changes" : "read"),
    split = parameters.layout === DifferenceLayout.Split,
    url = (view: "changes" | "edit") =>
      location({
        view,
        ...(view === "changes" ? { layout: split ? DifferenceLayout.Split : DifferenceLayout.Inline } : {}),
      }),
    record = {
      directory: context.root,
      path: `plans/${plan.scope}/${plan.name}/plan.md`,
      title: plan.title,
      type: "TSK" as const,
      scope: plan.scope,
      fileSource: sourceQuery(context),
      planFiles: { reference: plan.reference, files: attachmentBlobs(plan.files) },
    };
  const approvedBlobs = attachmentBlobs(plan.approval?.files ?? []);
  const fileLink = (name: string, version?: "approved", image?: string) =>
    sourceURL(
      context,
      routeURL(Route.PlanFile, {
        id: plan.reference,
        path: name,
        ...(version ? { version } : {}),
        ...(image ? { image } : {}),
      }),
    );
  let body: ComponentChildren;
  if (view === "edit")
    body = mutationForm({
      action: Route.PlanSave,
      context,
      csrf: context.csrf,
      class: "form-grid",
      fields: { reference: plan.reference, expected: draft?.expected ?? plan.digest },
      children: (controls) => (
        <>
          {draft && (
            <p class="notice error" role="alert">
              {draft.error} Your draft is preserved below.
            </p>
          )}
          {controls.area("contents", { id: "plan-editor", label: "Plan", value: draft?.contents ?? plan.contents })}
          <div class="actions">
            {linkButton("Cancel", back, true)}
            {submitButton("Save draft")}
          </div>
        </>
      ),
    });
  else if (view === "changes") {
    if (!plan.approval) throw new WebError(400, "This plan has not been approved");
    body = sourceDiffView(
      { before: plan.approval.contents, after: plan.contents, patch: "" },
      {
        record,
        previousRecord: {
          ...record,
          planFiles: { reference: plan.reference, files: approvedBlobs, version: "approved" },
        },
        records: context.index.references,
        pageTitle: plan.title,
      },
      split,
    );
  } else body = markdown(plan.contents, record, context.index.references, plan.title);
  return shell(
    context,
    plan.title,
    active,
    <>
      <p class="record-location">
        <span class="file-path">{plan.name}</span>
        {recordStatus({ id: plan.reference, type: "TSK", status: plan.status }, context)}
        {addedAtTag(plan.addedAt)}
        {plan.draft && badge("Draft")}
      </p>
      {plan.implementation && (
        <p class="notice">
          Implementation continues as{" "}
          {context.index.byId.has(plan.implementation.task) ? (
            <a href={routeURL(Route.Record, { id: plan.implementation.task })}>{plan.implementation.task}</a>
          ) : (
            <code>{plan.implementation.task}</code>
          )}{" "}
          in <code>{plan.implementation.checkout}</code>.
        </p>
      )}
      {plan.problem && (
        <p class="notice error" role="alert">
          {plan.problem}
        </p>
      )}
      {plan.conflict && (
        <p class="notice error" role="alert">
          The draft and planning branch changed independently. Reconcile both versions before approval.
        </p>
      )}
      {recordPane(
        panel(body, {
          tools:
            view !== "edit" ? (
              <>
                {view === "changes" && diffLayout(url("changes"), split)}
                {!plan.implementation && linkButton("Edit", url("edit"), true)}
              </>
            ) : null,
        }),
        navigation,
      )}
      {plan.changedFiles.length > 0 && plan.approval && (
        <ul aria-label="Supporting file changes">
          {plan.changedFiles.map((file) => (
            <li key={file.name}>
              {file.name}: {file.change}{" "}
              {file.change !== "added" && (
                <a
                  href={sourceURL(
                    context,
                    routeURL(Route.PlanFile, { id: plan.reference, path: file.name, version: "approved" }),
                  )}
                >
                  Previous
                </a>
              )}{" "}
              {file.change !== "removed" && (
                <a href={sourceURL(context, routeURL(Route.PlanFile, { id: plan.reference, path: file.name }))}>
                  Current
                </a>
              )}
              {view === "changes" && isSvg(file.name) && (
                <div class="document">
                  {[approvedBlobs.get(file.name), record.planFiles.files.get(file.name)].map((oid, index) => {
                    if (!oid) return null;
                    const caption = index === 0 ? "Previous" : "Current";
                    return (
                      <figure key={caption}>
                        <figcaption>{caption}</figcaption>
                        <img
                          src={fileLink(file.name, index === 0 ? "approved" : undefined, oid)}
                          alt={`${caption} ${file.name}`}
                          loading="lazy"
                        />
                      </figure>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {view === "edit" && !plan.implementation && (
        <details>
          <summary>Rename plan</summary>
          {mutationForm({
            action: Route.PlanRename,
            context,
            csrf: context.csrf,
            fields: { reference: plan.reference, expected: plan.digest },
            children: (controls) => (
              <>
                {controls.text("name", {
                  id: "new-plan-name",
                  label: "New name",
                  value: plan.name,
                  required: true,
                  pattern: "[a-z][a-z0-9_-]{0,119}",
                  maxLength: 120,
                })}
                {submitButton("Rename plan", { secondary: true })}
              </>
            ),
          })}
        </details>
      )}
      {plan.files.length > 0 && (
        <section aria-label="Supporting files">
          <h2>Supporting files</h2>
          <ul>
            {plan.files.map((file) => (
              <li key={file.name}>
                <a href={sourceURL(context, routeURL(Route.PlanFile, { id: plan.reference, path: file.name }))}>
                  {planningPaths.files + file.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view !== "edit" && !plan.implementation && (
        <section aria-label="Plan actions" class="task-workflow">
          {taskDecisionActions(
            planActions ? "plan" : "task",
            !plan.problem &&
              !plan.conflict &&
              (state === TaskLifecycle.Planned || state === TaskLifecycle.AwaitingApproval)
              ? needsPreparation
                ? reviewPreparationForm(
                    context,
                    {
                      owner: indexedPath,
                      layout: differenceLayout(parameters),
                      task: { reference: plan.reference, expected: plan.digest },
                      ...(parameters.view === "read" || parameters.view === "changes"
                        ? { recordView: parameters.view }
                        : {}),
                    },
                    "Review plan",
                  )
                : mutationForm({
                    action: Route.PlanApprove,
                    context,
                    csrf: context.csrf,
                    fields: { reference: plan.reference, expected: plan.digest },
                    children: () => submitButton("Approve plan"),
                  })
              : null,
            [
              planActions && linkButton("Delete plan", location({ view: "delete" }), true),
              !plan.problem &&
                !plan.conflict &&
                state !== TaskLifecycle.Canceled &&
                linkButton(cancelLabel, location({ view: "cancel" }), true),
              !plan.problem &&
                !plan.conflict &&
                (state === TaskLifecycle.Canceled || state === TaskLifecycle.AwaitingImplementation) &&
                mutationForm({
                  action: Route.PlanApprove,
                  context,
                  csrf: context.csrf,
                  fields: { reference: plan.reference, expected: plan.digest, intent: "revise" },
                  children: () =>
                    submitButton(
                      state === TaskLifecycle.Canceled ? (planActions ? "Reopen plan" : "Reopen task") : "Revise plan",
                      { secondary: true },
                    ),
                }),
            ],
          )}
        </section>
      )}
    </>,
    { parents: workflow },
  );
}

export function planFilePage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.PlanFile>,
  contents: string | undefined,
): string {
  const id = parameters.id ?? "",
    path = parameters.path ?? "";
  const plan = context.index.snapshot.tasks.plans.find((plan) => plan.reference === id);
  const navigation = taskWorkflowNavigation(context, id);
  const record = {
    fileSource: sourceQuery(context),
    directory: context.root,
    path,
    ...(plan ? { scope: plan.scope } : {}),
    ...(plan
      ? {
          planFiles: {
            reference: id,
            files: attachmentBlobs(parameters.version === "approved" ? (plan.approval?.files ?? []) : plan.files),
            ...(parameters.version ? { version: parameters.version } : {}),
            base: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
          },
        }
      : {}),
  };
  return shell(
    context,
    path,
    navigation.active ?? "plans",
    <>
      {panel(
        contents === undefined ? (
          <p>This file requires download for inspection.</p>
        ) : /\.(?:md|markdown)$/i.test(path) ? (
          markdown(contents, record, context.index.references)
        ) : (
          <pre class="source">{contents}</pre>
        ),
      )}
      <p class="actions document-actions">
        {linkButton("Download file", routeURL(Route.PlanFile, { ...parameters, id, path, download: "1" }), true)}
      </p>
    </>,
    {
      parents: [
        ...(navigation.phase ? navigation.parents : [workflowParent(context, Route.Plans)]),
        { label: plan?.title ?? id, href: sourceURL(context, routeURL(Route.Plan, { id })) },
      ],
    },
  );
}
