import { validation, type Validation } from "../../core/runtime/validation.js";
import { PreparationState } from "../review/review-state.js";
import { decodeWorkerFailure } from "../http/error-response.js";
import { PolicyCompatibilityState } from "../../core/collections/policy-compatibility.js";
import { decodeCompatibilityAssessment } from "../../core/collections/policy-findings.js";
import { LocalCollectionScope } from "../../core/collections/collections.js";
import { decodeQueue } from "../../core/tasks/task-queue.js";
import { decodeApplicableTaskImplementation } from "../../core/tasks/task-implementations.js";
import { taskStatuses, recordTimestamp } from "../../core/records/record-document.js";
import { recordTypes } from "../../core/records/record-metadata.js";
import type { WorkspaceSnapshot } from "./workspace-service.js";

const boundary: Validation = validation("invalid workspace worker snapshot");
function check(valid: boolean, field = "value"): asserts valid {
  boundary(valid, field, "has an invalid shape");
}
function object(value: unknown): Record<string, unknown> {
  check(!!value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const text = (value: unknown): value is string => typeof value === "string";
const bool = (value: unknown) => typeof value === "boolean";
const bytes = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown) => value === null || text(value);
function list(value: unknown, visit: (entry: unknown) => void): void {
  check(Array.isArray(value));
  for (const entry of value) visit(entry);
}
function strings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) check(text(value[key]), key);
}
function entries(value: unknown, visit: (entry: unknown, key: string) => void): void {
  check(value instanceof Map);
  for (const [key, entry] of value as Map<unknown, unknown>) {
    check(text(key));
    visit(entry, key);
  }
}
function difference(value: unknown): void {
  if (value === null) return;
  const difference = object(value);
  strings(difference, ["before", "after"]);
  check(difference.patch === undefined || text(difference.patch));
}
function comparison(value: unknown): void {
  const data = object(value);
  if (data.state === "available") difference(data.difference);
  else check(data.state === "unavailable" && data.difference === null && text(data.problem));
}
function review(value: unknown): void {
  const data = object(value);
  strings(data, ["digest", "receipt"]);
  list(data.changes, (value) => {
    const change = object(value);
    strings(change, ["path", "before", "after", "digest"]);
    check(bool(change.charter) && bool(change.approved));
  });
}
function assertSnapshot(value: unknown): asserts value is WorkspaceSnapshot {
  const data = object(value);
  strings(data, ["root", "revision", "collectedAt"]);
  check(bytes(data.retainedSize) && Number(data.retainedSize) <= 64 * 1024 * 1024, "retainedSize");
  check(text(data.collectedAt) && Number.isFinite(Date.parse(data.collectedAt)));
  const compatibility = object(data.compatibility);
  check(text(compatibility.error));
  if (compatibility.report !== null) {
    const report = object(compatibility.report);
    strings(report, ["digest", "project", "local", "receipt"]);
    check(Object.values(PolicyCompatibilityState).some((state) => state === report.status));
    check(report.reviewed_at === null || (text(report.reviewed_at) && Number.isFinite(Date.parse(report.reviewed_at))));
    if (report.assessment !== null) decodeCompatibilityAssessment(report.assessment);
    if (report.last_resolution !== null) decodeCompatibilityAssessment(report.last_resolution);
    list(report.sources, (value) => {
      strings(object(value), ["id", "directory", "digest"]);
    });
    list(report.project_sources, (value) => {
      const source = object(value);
      strings(source, ["id", "decision_map"]);
      list(source.scopes, (scope) => {
        check(text(scope));
      });
    });
    list(report.conflicts, (value) => {
      check(text(value));
    });
    list(report.stale_contexts, (value) => {
      check(text(value));
    });
  }
  list(data.commitReviews, (value) => {
    const unit = object(value);
    strings(unit, ["revision", "subject"]);
    check(bytes(unit.files));
    list(unit.taskPaths, (path) => {
      check(text(path));
    });
    list(unit.paths, (path) => {
      check(text(path));
    });
  });
  list(data.projects, (value) => {
    const project = object(value);
    strings(project, ["id", "path"]);
    check(project.name === undefined || text(project.name));
  });
  list(data.records, (value) => {
    const record = object(value);
    strings(record, ["id", "scope", "title", "summary", "status", "path", "directory"]);
    check(record.addedAt === undefined || recordTimestamp(record.addedAt));
    check(
      recordTypes.some((type) => type === record.type) &&
        bool(record.editable) &&
        bool(record.local) &&
        bool(record.collection),
    );
    if (record.archive !== undefined) {
      const archive = object(record.archive);
      strings(archive, ["repository", "revision", "path"]);
      check(text(archive.revision) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(archive.revision));
      check(!record.editable && !record.local && !record.collection);
      check(archive.repository === data.root && archive.path === record.path && record.directory === data.root);
    }
    check(record.previewError === undefined || text(record.previewError));
    check(record.adaptation === undefined || record.adaptation === "added" || record.adaptation === "modified");
    if (record.citationPresence !== undefined) {
      const citation = object(record.citationPresence);
      check(text(citation.error) || (bytes(citation.present) && bytes(citation.total)));
    }
  });
  const preparation = object(data.reviewPreparation);
  check(bytes(preparation.width) && Number(preparation.width) > 0);
  list(preparation.pendingOutputs, (path) => {
    check(text(path));
  });
  entries(preparation.files, (value) => {
    const entry = object(value);
    check(
      entry.state === PreparationState.Required ||
        (entry.state === PreparationState.Unavailable && text(entry.problem)),
    );
  });
  const tasks = object(data.tasks);
  const planFiles = (value: unknown) => {
    list(value, (item) => {
      const file = object(item);
      strings(file, ["name", "oid"]);
      check(bool(file.executable));
    });
  };
  list(tasks.plans, (value) => {
    const plan = object(value);
    strings(plan, ["reference", "scope", "name", "title", "summary", "contents", "digest", "status"]);
    check(plan.addedAt === undefined || recordTimestamp(plan.addedAt));
    check(bool(plan.draft) && bool(plan.conflict));
    if (plan.implementation !== undefined) {
      const implementation = object(plan.implementation);
      strings(implementation, ["task", "checkout"]);
      check(bool(implementation.pending));
    }
    check(plan.problem === undefined || text(plan.problem));
    check(plan.parent === undefined || text(plan.parent));
    list(plan.dependencies, (value) => {
      check(text(value));
    });
    planFiles(plan.files);
    list(plan.changedFiles, (value) => {
      const file = object(value);
      check(text(file.name) && ["added", "changed", "removed"].includes(String(file.change)));
    });
    if (plan.approval !== undefined) {
      const approval = object(plan.approval);
      check(text(approval.at) && text(approval.contents) && bool(approval.current));
      planFiles(approval.files);
    }
  });
  check(bool(tasks.decisionsRequired));
  check(text(tasks.problem));
  decodeQueue(tasks.queue);
  entries(tasks.errors, (value) => {
    check(text(value));
  });
  list(tasks.records, (value) => {
    const task = object(value);
    strings(task, ["reference", "title", "path", "contents", "digest", "planDigest"]);
    check(task.reviewDigest === undefined || text(task.reviewDigest));
    check(task.acceptanceNeedsReview === undefined || task.acceptanceNeedsReview === true);
    check(task.previouslyApproved === undefined || task.previouslyApproved === true);
    check(task.finalized === undefined || task.finalized === true);
    check(task.committedDelivery === undefined || task.committedDelivery === true);
    check(task.verificationStale === undefined || task.verificationStale === true);
    if (task.approval !== undefined) {
      const approval = object(task.approval);
      check(text(approval.at) && text(approval.contents) && bool(approval.current));
      check(approval.source === undefined || approval.source === "developer-requested-review");
      list(approval.files, (value) => {
        const file = object(value);
        check(text(file.name) && ["added", "changed", "removed"].includes(String(file.change)));
      });
    }
    check(task.parent === undefined || text(task.parent));
    check(task.archived === undefined || bool(task.archived));
    if (task.implementation !== undefined) decodeApplicableTaskImplementation(task.implementation);
    list(task.dependencies, (value) => {
      check(text(value));
    });
    check(taskStatuses.some((status) => status === object(task.metadata).status));
  });
  review(data.review);
  check(text(object(data.review).head));
  entries(data.documents, (value) => {
    const document = object(value);
    strings(document, ["contents", "digest", "error"]);
    reviewBaseline(document.baseline);
    comparison(document.reviewed);
    if (document.taskFiles !== undefined)
      list(document.taskFiles, (value) => {
        const file = object(value);
        check(text(file.name) && ["added", "changed", "removed"].includes(String(file.change)));
      });
    list(document.files, (value) => {
      const file = object(value);
      check(text(file.path) && bytes(file.size));
    });
    if (document.modeChange !== undefined) strings(object(document.modeChange), ["before", "after"]);
    if (document.citation !== undefined) {
      const citation = object(document.citation);
      check(text(citation.error));
      if (citation.failure !== undefined) decodeWorkerFailure(citation.failure);
      list(citation.sources, (value) => {
        const source = object(value);
        strings(source, ["kind", "state", "path", "originalPath", "documentUrl", "landingUrl"]);
        check(
          (source.format === "pdf" || source.format === "html") && bool(source.present) && bool(source.originalPresent),
        );
        check(["pending", "acquired", "unavailable"].includes(String(source.state)));
        for (const field of ["downloadUrl", "sha256", "originalSha256", "charset", "reason"])
          check(source[field] === undefined || text(source[field]));
      });
    }
  });
  entries(data.reviewDocuments, (value) => {
    const document = object(value);
    strings(document, ["error"]);
    reviewBaseline(document.baseline);
    check(nullableText(document.baselineContents));
    check(nullableText(document.before) && nullableText(document.after));
    comparison(document.reviewed);
  });
  list(data.collections, (value) => {
    const collection = object(value),
      pin = object(collection.pin);
    strings(pin, ["id", "revision", "sha256", "visibility"]);
    check(
      (pin.visibility === "public" || pin.visibility === "private") &&
        text(collection.directory) &&
        bool(collection.local) &&
        (collection.local
          ? Object.values(LocalCollectionScope).some((scope) => scope === collection.localScope)
          : collection.localScope === undefined),
    );
  });
  entries(data.comparisons, (value) => {
    const comparison = object(value);
    check(text(comparison.revision));
    if (comparison.state !== "compared")
      check(
        text(comparison.state) &&
          ["published", "originals-unavailable", "read-error"].includes(comparison.state) &&
          text(comparison.message),
      );
    else
      list(comparison.decisions, (value) => {
        const decision = object(value);
        strings(decision, ["id", "path"]);
        if (decision.status === "added") check(decision.before === undefined && text(decision.after));
        else if (decision.status === "removed") check(text(decision.before) && decision.after === undefined);
        else
          check(
            (decision.status === "modified" || decision.status === "unchanged") &&
              text(decision.before) &&
              text(decision.after),
          );
      });
  });
  entries(data.removedReviews, comparison);
  entries(data.inputs, (stamp) => {
    check(text(stamp));
  });
  list(data.directories, (value) => {
    check(text(value));
  });
}
export function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  assertSnapshot(value);
  return value;
}

function reviewBaseline(value: unknown): void {
  const baseline = object(value);
  check(
    baseline.kind === "new" ||
      baseline.kind === "commit" ||
      (baseline.kind === "review" && text(baseline.approvedAt) && Number.isFinite(Date.parse(baseline.approvedAt))),
  );
}
