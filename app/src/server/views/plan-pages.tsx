import type { ComponentChildren } from "preact";
import { planningPaths } from "../../core/tasks/planning/plan-model.js";
import { WebError } from "../http/errors.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import { DifferenceLayout } from "../routes/navigation-state.js";
import { shell } from "./page-frame.js";
import { badge, panel, submitButton } from "./components.js";
import { mutationForm } from "./action-forms.js";
import { tabs, linkButton, diffLayout } from "./render-links.js";
import { markdown } from "./markdown-view.js";
import { sourceDiffView } from "./diff-view.js";
import type { ViewContext } from "../workspace/view-context.js";

export function newPlanPage(context: ViewContext, draft?: { name: string; contents: string; error: string }): string {
  if (context.selection) throw new WebError(400, "Create plans in a project scope");
  return shell(
    context,
    "New plan",
    "queue",
    mutationForm({
      action: Route.PlanCreate,
      context,
      csrf: context.csrf,
      fields: { scope: context.scope },
      class: "form-grid",
      children: (controls) => (
        <>
          {draft && (
            <p class="notice error" role="alert">
              {draft.error}
            </p>
          )}
          {controls.text("name", {
            id: "plan-name",
            label: "Plan name",
            value: draft?.name ?? "",
            pattern: "[a-z][a-z0-9_-]{0,119}",
            required: true,
            maxLength: 120,
          })}
          {controls.area("contents", {
            id: "plan-editor",
            label: "Plan",
            value: draft?.contents ?? "---\nstatus: Planned\n---\n\n# Plan title\n",
          })}
          <div class="actions">
            {submitButton("Create draft")}
            {linkButton("Cancel", routeURL(Route.TaskQueue, { scope: context.scope }), true)}
          </div>
        </>
      ),
    }),
    { parents: [{ label: "Workflow", href: routeURL(Route.TaskQueue, { scope: context.scope }) }] },
  );
}
export function planPage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Plan>,
  draft?: { contents: string; expected: string; error: string },
): string {
  const plan = context.index.snapshot.tasks.plans.find((plan) => plan.reference === parameters.id);
  if (!plan) throw new WebError(404, "Plan not found");
  if (plan.implementation && parameters.view === "edit")
    throw new WebError(409, "Edit the implementation task; this saved plan is read only");
  const view = parameters.view ?? "read",
    split = parameters.layout === DifferenceLayout.Split,
    url = (view: "read" | "changes" | "edit") =>
      routeURL(Route.Plan, {
        id: plan.reference,
        view,
        scope: context.scope,
        ...(view === "changes" ? { layout: split ? DifferenceLayout.Split : DifferenceLayout.Inline } : {}),
      }),
    record = {
      directory: context.root,
      path: `plans/${plan.scope}/${plan.name}/plan.md`,
      title: plan.title,
      type: "TSK" as const,
      scope: plan.scope,
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
            {submitButton("Save draft")}
            {linkButton("Cancel", url("read"), true)}
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
  const choices = [
    { label: "Read", href: url("read"), current: view === "read" },
    ...(plan.approval && (plan.approval.contents !== plan.contents || plan.changedFiles.length)
      ? [{ label: "Diff", href: url("changes"), current: view === "changes" }]
      : []),
    ...(!plan.implementation ? [{ label: "Edit", href: url("edit"), current: view === "edit" }] : []),
  ];
  return shell(
    context,
    plan.title,
    "queue",
    <>
      <p class="record-location">
        <span class="file-path">{plan.name}</span>
        {badge(plan.status)}
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
          The draft and planning branch changed independently. Reconcile both versions before checkpointing or approval.
        </p>
      )}
      {panel(body, {
        tabs: tabs(choices, "Plan views"),
        tools: view === "changes" ? diffLayout(url("changes"), split) : null,
      })}
      {plan.changedFiles.length > 0 && plan.approval && (
        <ul aria-label="Supporting file changes">
          {plan.changedFiles.map((file) => (
            <li key={file.name}>
              {file.name}: {file.change}{" "}
              {file.change !== "added" && (
                <a href={routeURL(Route.PlanFile, { id: plan.reference, path: file.name, version: "approved" })}>
                  Previous
                </a>
              )}{" "}
              {file.change !== "removed" && (
                <a href={routeURL(Route.PlanFile, { id: plan.reference, path: file.name })}>Current</a>
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
                <a href={routeURL(Route.PlanFile, { id: plan.reference, path: file.name })}>
                  {planningPaths.files + file.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div class="task-actions">
        {!plan.implementation &&
          !plan.problem &&
          !plan.conflict &&
          plan.status !== "Canceled" &&
          !plan.approval?.current &&
          mutationForm({
            action: Route.PlanApprove,
            context,
            csrf: context.csrf,
            fields: { reference: plan.reference, expected: plan.digest },
            children: () => submitButton(plan.approval ? "Approve revised plan" : "Approve plan"),
          })}
        {plan.draft &&
          !plan.implementation &&
          !plan.problem &&
          !plan.conflict &&
          mutationForm({
            action: Route.PlanCheckpoint,
            context,
            csrf: context.csrf,
            fields: { reference: plan.reference, expected: plan.digest },
            children: () => submitButton("Checkpoint plan", { secondary: true }),
          })}
      </div>
    </>,
    { parents: [{ label: "Workflow", href: routeURL(Route.TaskQueue, { scope: plan.scope }) }] },
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
  const record = {
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
    "queue",
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
        { label: "Workflow", href: routeURL(Route.TaskQueue, { scope: context.scope }) },
        { label: id, href: routeURL(Route.Plan, { id }) },
      ],
    },
  );
}
