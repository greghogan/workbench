import type { JSX } from "preact";
import type { BrowserRecord } from "../../core/records/record-service.js";
import type { ViewContext } from "../workspace/view-context.js";
import { experimentIsResult } from "../../core/experiments/experiment-workflow.js";
import { linkButton } from "./render-links.js";
import { reviewLocation } from "../review/review-navigation.js";

export function experimentControls(context: ViewContext, record: BrowserRecord): JSX.Element | null {
  if (
    record.type !== "EXP" ||
    record.local ||
    record.collection ||
    !!record.archive ||
    !experimentIsResult(record.status) ||
    !context.hasPendingReview(record.path) ||
    context.document(record.id).error
  )
    return null;
  return <p class="actions document-actions">{linkButton("Review outcome", reviewLocation(context, record))}</p>;
}
