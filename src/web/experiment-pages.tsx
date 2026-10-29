import type { ExperimentStatus } from "../record-document.js";
import type { JSX } from "preact";
import type { BrowserRecord } from "../record-service.js";
import type { ViewContext } from "./view-context.js";
import { experimentIsResult } from "../experiment-workflow.js";
import { taskDigest } from "../task-model.js";
import { mutationForm } from "./action-forms.js";
import { submitButton } from "./components.js";
import { linkButton } from "./render-links.js";
import { reviewLocation } from "./review-navigation.js";
import { Route } from "./routes.js";

export function experimentControls(context: ViewContext, record: BrowserRecord): JSX.Element | null {
  if (record.type !== "EXP" || record.local || record.collection) return null;
  const document = context.document(record.id);
  if (document.error) return null;
  const action = (state: ExperimentStatus, label: string) =>
    mutationForm({
      action: Route.TaskState,
      context,
      csrf: context.csrf,
      fields: { reference: record.id, state, expected: taskDigest(document.contents) },
      children: () => submitButton(label),
    });
  return (
    <section aria-label="Experiment workflow" class="task-workflow">
      <h2>Experiment workflow</h2>
      {record.status === "Planned" && action("Running", "Start experiment")}
      {experimentIsResult(record.status) && action("Running", "Resume experiment")}
      {!experimentIsResult(record.status) && record.status !== "Planned" && action("Planned", "Return to planning")}
      {experimentIsResult(record.status) &&
        (context.index.reviewGroups.get(record.path)?.pending ?? 0) > 0 &&
        linkButton("Review outcome", reviewLocation(context, record))}
    </section>
  );
}
