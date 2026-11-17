import { recordPane } from "./record-pane.js";
import { taskWorkflowNavigation, workflowParent } from "./workflow-navigation.js";
import { sourceQuery, sourceURL } from "../routes/sources.js";
import { planDeletion } from "../../core/tasks/planning/plan-disposition.js";
import type { ComponentChildren } from "preact";
import { planningPaths, parsePlanReference } from "../../core/tasks/planning/plan-model.js";
import { WebError } from "../http/errors.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import { DifferenceLayout } from "../routes/navigation-state.js";
import { shell } from "./page-frame.js";
import { badge, panel, submitButton, confirmationActions } from "./components.js";
import { mutationForm } from "./action-forms.js";
import { linkButton, diffLayout } from "./render-links.js";
import { markdown } from "./markdown-view.js";
import { sourceDiffView } from "./diff-view.js";
import { addedAtTag } from "./record-content.js";
import type { ViewContext } from "../workspace/view-context.js";

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
  const workflow = navigation.phase ? navigation.parents : [workflowParent(context, Route.Plans)];
  const parents = [...workflow, { label: plan.title, href: back }];
  if (parameters.view === "cancel") {
    if (plan.implementation || plan.status === "Canceled" || plan.problem || plan.conflict)
      throw new WebError(409, "This plan cannot be canceled in its current state");
    return shell(
      context,
      "Cancel plan",
      plan.status === "Approved" && plan.approval?.current ? "work" : "plans",
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
      plan.status === "Approved" && plan.approval?.current ? "work" : "plans",
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
      planFiles: { reference: plan.reference, names: plan.files.map((file) => file.name) },
    };
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
      { record, records: context.index.references, pageTitle: plan.title },
      split,
    );
  } else body = markdown(plan.contents, record, context.index.references, plan.title);
  return shell(
    context,
    plan.title,
    plan.status === "Approved" && plan.approval?.current ? "work" : "plans",
    <>
      <p class="record-location">
        <span class="file-path">{plan.name}</span>
        {badge(plan.status)}
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
          {!plan.problem && !plan.conflict && plan.status !== "Canceled" && !plan.approval?.current && (
            <div class="task-actions">
              {mutationForm({
                action: Route.PlanApprove,
                context,
                csrf: context.csrf,
                fields: { reference: plan.reference, expected: plan.digest },
                children: () => submitButton(plan.approval ? "Approve revised plan" : "Approve plan"),
              })}
            </div>
          )}
          <details>
            <summary>Plan actions</summary>
            <div class="task-actions">
              {linkButton("Delete plan", location({ view: "delete" }), true)}
              {!plan.problem &&
                !plan.conflict &&
                plan.status !== "Canceled" &&
                linkButton("Cancel plan", location({ view: "cancel" }), true)}
            </div>
          </details>
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
            names:
              parameters.version === "approved"
                ? [
                    ...plan.files
                      .filter(
                        (file) =>
                          !plan.changedFiles.some((change) => change.name === file.name && change.change === "added"),
                      )
                      .map((file) => file.name),
                    ...plan.changedFiles.filter((file) => file.change === "removed").map((file) => file.name),
                  ]
                : plan.files.map((file) => file.name),
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
