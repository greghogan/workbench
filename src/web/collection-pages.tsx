import type { CollectionRequest } from "./collection-service.js";
import { badge, submitButton } from "./components.js";
import { sourceDifference } from "./diff.js";
import { projectPath } from "./project-paths.js";
import type { CollectionPreview } from "./protocol.js";
import { mutationForm } from "./action-forms.js";
import { Route } from "./routes.js";
import { shell } from "./page-frame.js";
import { sourceDiffView } from "./diff-view.js";
import { type ViewContext } from "./view-context.js";
export function collectionsPage(context: ViewContext): string {
  const collections = context.collections;
  const options = collections
    .filter((collection) => !collection.local)
    .map((collection) => ({
      value: collection.pin.id,
      label: "Update " + collection.pin.id,
    }));
  return shell(
    context,
    "Collections",
    "collections",
    <>
      <p class="subtitle">Inspect adopted policy and preview a pinned collection before changing project files.</p>
      <p class="notice">
        After applying a collection: run <code>workbench sync</code>, <code>workbench collection stage ID</code>, stage
        the intended files with Git, review each source in the <a href={projectPath("/review")}>review queue</a>, then
        run <code>workbench validate</code>. Application does not stage, commit or approve records.
      </p>
      <section class="panel">
        {collections.length ? (
          collections.map((collection) => (
            <div class="record-row">
              <h2>{collection.pin.id}</h2>
              {badge(collection.local ? "Local · read only" : "Project-owned")}
              {badge(collection.pin.visibility)}
              <p class="file-path">
                Revision {collection.pin.revision}
                <br />
                SHA-256 {collection.pin.sha256}
              </p>
              <a href={projectPath("/records") + "?collection=" + encodeURIComponent(collection.pin.id)}>
                Browse records
              </a>
            </div>
          ))
        ) : (
          <p class="empty">No installed collections.</p>
        )}
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>Add or update a project collection</h2>
        </div>
        <div class="panel-body">
          {mutationForm({
            action: Route.Preview,
            csrf: context.csrf,
            context,
            class: "form-grid",
            fields: {},
            children: (controls) => (
              <>
                {controls.select("id", {
                  id: "collection-id",
                  label: "Operation",
                  value: "",
                  choices: [{ value: "", label: "Add collection" }, ...options],
                })}
                {controls.text("source", {
                  id: "collection-source",
                  value: context.collectionDefaults?.source ?? "",
                  label: "Git repository",
                  required: true,
                  placeholder: "https://… or a local repository path",
                })}
                {controls.text("commit", {
                  id: "collection-commit",
                  value: context.collectionDefaults?.commit ?? "",
                  label: "Full immutable Git commit",
                  required: true,
                  pattern: "[0-9a-f]{40}([0-9a-f]{24})?",
                  spellcheck: false,
                })}
                {controls.text("collection", {
                  id: "collection-path",
                  label: "Collection directory within repository",
                  value: ".",
                  required: true,
                })}
                {controls.select("visibility", {
                  id: "collection-visibility",
                  label: "Audience",
                  value: "private",
                  choices: [
                    { value: "private", label: "Private" },
                    { value: "public", label: "Public" },
                  ],
                })}
                <p class="muted">
                  Preview verifies and retains source objects. It does not activate policy or change project files.
                  Existing adaptations are reconciled; conflicts preserve a proposal for manual resolution.
                </p>
                {submitButton("Prepare preview")}
              </>
            ),
          })}
        </div>
      </section>
    </>,
  );
}
export function collectionProposalPage(
  context: ViewContext,
  token: string,
  request: CollectionRequest,
  plan: CollectionPreview,
): string {
  return shell(
    context,
    "Review collection proposal",
    "collections",
    <>
      <p>
        {badge(plan.pin.id)}
        {badge(plan.pin.visibility)}
      </p>
      <p class="file-path">
        Source: {request.source}
        <br />
        Commit: {request.commit}
        <br />
        Review SHA-256: {plan.digest}
      </p>
      <p class="notice">
        Applying this proposal changes project files. It does not stage, commit, or acknowledge compatibility. Review
        adopted ADRs before committing.
      </p>
      <section class="panel">
        <div class="panel-heading">
          <h2>Proposed file changes ({String(plan.files.length)})</h2>
        </div>
        <div class="panel-body">
          {plan.files.length ? (
            plan.files.map((file) => (
              <details>
                <summary>
                  {file.path} ·{" "}
                  {file.before_sha256 === null ? "added" : file.after_sha256 === null ? "removed" : "modified"}
                </summary>
                {/\/ADR-[0-9A-Z]+\.md$/.test(file.path) && file.before !== null && file.after !== null ? (
                  sourceDiffView(
                    sourceDifference(file.before, file.after, file.path, plan.differences[file.path] ?? ""),
                  )
                ) : (
                  <>
                    <p>Previous contents</p>
                    <pre class="source">{file.before ?? "Absent or binary file"}</pre>
                    <p>Proposed contents</p>
                    <pre class="source">{file.after ?? "Absent or binary file"}</pre>
                  </>
                )}
                <p class="file-path">
                  Before: {file.before_sha256 ?? "absent"}
                  <br />
                  After: {file.after_sha256 ?? "absent"}
                </p>
              </details>
            ))
          ) : (
            <p>No file changes.</p>
          )}
          {mutationForm({
            action: Route.Apply,
            csrf: context.csrf,
            context,
            class: "form-grid",
            fields: { token },
            children: (controls) => (
              <>
                {controls.confirmation("reviewed", "I have reviewed this exact proposal and approve applying it.")}
                {submitButton("Apply reviewed proposal", { approve: true })}
              </>
            ),
          })}
        </div>
      </section>
    </>,
    { parents: [{ label: "Collections", href: "/collections" }] },
  );
}
