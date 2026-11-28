import type { JSX } from "preact";
import { projectName } from "../../core/projects/project-hierarchy.js";
import { panel, submitButton } from "./components.js";
import { WebError } from "../http/errors.js";
import { projectPath } from "../routes/project-paths.js";
import { linkButton } from "./render-links.js";
import { mutationForm } from "./action-forms.js";
import { routeURL } from "../routes/locations.js";
import { Route } from "../routes/routes.js";
import { shell } from "./page-frame.js";
import { recordList } from "./record-content.js";
import { type ViewContext } from "../workspace/view-context.js";

export function chartersPage(context: ViewContext): string {
  const charters = context.selectedRecords.filter((record) => record.type === "CHARTER");
  const setup = onboarding(context);
  return shell(
    context,
    "Charters",
    "CHARTER",
    <>
      {setup}
      {charters.length ? recordList(charters, context) : setup ? null : <p class="empty">No charters.</p>}
    </>,
  );
}

function onboarding(context: ViewContext): JSX.Element | null {
  if (context.selection) return null;
  const missing = context.projects.filter(
    (project) => (context.all || project.id === context.scope) && !context.index.byId.has(project.id + ":CHARTER"),
  );
  if (!missing.length) return null;
  return panel(
    <>
      <p>Start by writing your project's purpose and boundaries. Charters must be written by a human.</p>
      <ul>
        {missing.map((project) => (
          <li>
            {linkButton(
              "Create charter for " + projectName(project),
              routeURL(Route.NewCharter, { project: project.id }),
            )}
          </li>
        ))}
      </ul>
      <p>
        For application checks, choose a starter with <code>workbench init --language LANGUAGE</code>, or connect
        existing automation with <code>workbench init --adopt --language LANGUAGE --check COMMAND</code>. For documents
        alone, choose <code>workbench init --records-only</code>.
      </p>
      <p>
        Inspect <code>workbench language</code> and <code>workbench check --list</code>, then add optional policy
        through <a href={projectPath("/collections")}>Collections</a>. After editing records, run{" "}
        <code>workbench sync</code> and <code>workbench validate</code>.
      </p>
    </>,
    { heading: "Get started" },
  );
}
export function newCharterPage(
  context: ViewContext,
  projectId: string,
  draft?: { contents: string; error: string },
): string {
  const project = context.projects.find((project) => project.id === projectId);
  if (!project) throw new WebError(404, "project scope not found");
  if (context.index.byId.has(project.id + ":CHARTER") && !draft)
    throw new WebError(409, "this charter already exists; open its Edit view");
  return shell(
    context,
    "Create charter for " + projectName(project),
    "CHARTER",
    panel(
      mutationForm({
        action: Route.CreateCharter,
        csrf: context.csrf,
        context,
        class: "form-grid",
        fields: { project: project.id },
        children: (controls) => (
          <>
            <p>
              Write your project's purpose and boundaries in your own words. Saving creates the working file; it does
              not stage, approve or commit it.
            </p>
            {draft && (
              <p class="notice error" role="alert">
                {draft.error} Your draft is preserved below.
              </p>
            )}
            {controls.area("contents", { id: "charter-editor", label: "Charter text", value: draft?.contents ?? "" })}
            {controls.confirmation("human_written", "I wrote this charter text myself.")}
            {submitButton("Create charter")}
          </>
        ),
      }),
    ),
    {
      scope: project.id,
      parents: [{ label: "Charters", href: routeURL(Route.Charters, { scope: project.id }) }],
    },
  );
}
