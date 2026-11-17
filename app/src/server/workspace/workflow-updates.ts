import type { BrowserRecord } from "../../core/records/record-service.js";
import { contentDigest } from "../../core/records/record-service.js";
import { workflowRecordURL } from "../review/review-navigation.js";
import type { WorkspaceView } from "./workspace-service.js";

export interface WorkflowDecision {
  key: string;
  title: string;
  href: string;
  kind: "plan" | "outcome";
}

export function workflowUpdates(context: WorkspaceView, page?: "plans" | "work" | "reviews") {
  const plans = context.workflowPlans,
    approvals = context.workflowApprovals,
    outcomes = context.workflowOutcomes;
  const describe = (kind: WorkflowDecision["kind"], record: BrowserRecord): WorkflowDecision => ({
    key: `${kind}:${record.id}`,
    title: record.title,
    href: workflowRecordURL(context, record.id),
    kind,
  });
  const decisions = [
    ...approvals.map((record) => describe("plan", record)),
    ...outcomes.map((record) => describe("outcome", record)),
  ];
  if (!page) return { key: "", decisions };
  const state = (record: BrowserRecord) => [
    record.id,
    record.title,
    record.status,
    record.summary,
    record.addedAt,
    context.index.taskGraph.byReference.get(record.id)?.parent,
  ];
  const visible = {
    plans: () => plans.map(state),
    work: () => [
      context.taskQueue.entries,
      context.taskQueue.digest,
      context.taskQueue.ready,
      context.workflowWork.map((task) => [
        task.reference,
        task.title,
        task.parent,
        context.taskState(task.reference),
        context.index.taskReadiness.blockers(task),
      ]),
    ],
    reviews: () => [
      approvals.map(state),
      outcomes.map((record) => [state(record), context.taskDocumentReviews(record.id)]),
      context.standaloneCommitReviews,
      context.reviewSections.map((section) => [
        section.key,
        section.title,
        section.groups.map((group) => [
          group.path,
          group.pending,
          group.record ? state(group.record) : undefined,
          group.changes.map((change) => change.digest),
        ]),
      ]),
      context.pendingCompatibilityFindings,
      context.compatibilityNeedsHumanReview,
    ],
  };
  return {
    decisions,
    key: contentDigest(
      JSON.stringify([
        plans.length,
        context.workCount,
        context.pendingReviews,
        [...context.index.subprojectReviewCounts],
        context.index.snapshot.tasks.problem,
        context.projects,
        context.sources,
        context.selectedRecords.map((record) => record.type).sort(),
        visible[page](),
      ]),
    ),
  };
}
