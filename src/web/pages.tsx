import { compatibilityReviewItem } from "./compatibility-review.js";
import { projectPath } from "./project-paths.js";
import { onboarding } from "./charter-pages.js";
import { adaptationsPanel } from "./collection-summary.js";
import { recordList } from "./record-content.js";
import { shell } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
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
      {!context.collections.some((collection) => collection.local && collection.pin.id === context.selection) && (
        <section class="panel">
          <div class="panel-body">
            <h2>Review project changes</h2>
            <p>Review each changed record and its supporting files.</p>
            <a class="button" href={projectPath("/review")}>
              Open review queue{pending ? " (" + String(pending) + ")" : ""}
            </a>
          </div>
        </section>
      )}
      {context.compatibilityNeedsHumanReview && <section class="panel">{compatibilityReviewItem(context)}</section>}
      <h2>Charters</h2>
      {recordList(
        records.filter((record) => record.type === "CHARTER"),
        context,
      )}
      {adaptationsPanel(context)}
    </>,
  );
}
export { newCharterPage } from "./charter-pages.js";
export { collectionProposalPage, collectionsPage } from "./collection-pages.js";
export { recordPage, recordsPage, supportingFilePage, supportingDirectoryPage } from "./record-pages.js";
export { reviewPage } from "./review-page.js";
