import { onboarding } from "./charter-pages.js";
import { adaptationsPanel } from "./collection-summary.js";
import { recordList } from "./record-content.js";
import { shell } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { sourceURL } from "./sources.js";
export function overview(context: ViewContext): string {
  const records = context.selectedRecords,
    pending = context.pendingReviews;
  return shell(
    context,
    "Overview",
    "",
    <>
      {onboarding(context)}
      <p class="subtitle">
        Browse project knowledge, inspect decisions, and review the changes that need your attention.
      </p>
      <section class="panel">
        <div class="panel-body">
          <h2>Review project changes</h2>
          <p>
            Review working or staged files. An acknowledgment carries over when the exact reviewed contents are staged
            unchanged.
          </p>
          <a class="button" href={sourceURL(context, "/review")}>
            Open review queue{pending ? " (" + String(pending) + ")" : ""}
          </a>
        </div>
      </section>
      <h2>Charters</h2>
      {recordList(records.filter((record) => record.type === "CHARTER"))}
      {adaptationsPanel(context)}
    </>,
  );
}
export { newCharterPage } from "./charter-pages.js";
export { collectionProposalPage, collectionsPage } from "./collection-pages.js";
export { recordPage, recordsPage, supportingFilePage } from "./record-pages.js";
export { reviewPage } from "./review-page.js";
