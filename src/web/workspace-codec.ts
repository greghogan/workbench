import { decodeWorkerFailure } from "./error-response.js";
import { PolicyCompatibilityState } from "../policy-compatibility.js";
import { decodeCompatibilityAssessment } from "../policy-findings.js";
import { LocalCollectionScope } from "../collections.js";
import { decodeQueue } from "../task-queue.js";
import { decodeApplicableTaskImplementation } from "../task-implementations.js";
import { taskStatuses } from "../record-document.js";
import { recordTypes } from "../record-metadata.js";
import type { WorkspaceSnapshot } from "../workspace-service.js";

function check(valid: boolean): asserts valid {
  if (!valid) throw new Error("invalid workspace worker snapshot");
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
  for (const key of keys) check(text(value[key]));
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
  strings(object(value), ["patch", "before", "after"]);
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
  list(data.projects, (value) => {
    const project = object(value);
    strings(project, ["id", "path"]);
    check(project.name === undefined || text(project.name));
  });
  list(data.records, (value) => {
    const record = object(value);
    strings(record, ["id", "scope", "title", "summary", "status", "path", "directory"]);
    check(
      recordTypes.some((type) => type === record.type) &&
        bool(record.editable) &&
        bool(record.local) &&
        bool(record.collection),
    );
    check(record.previewError === undefined || text(record.previewError));
    check(record.adaptation === undefined || record.adaptation === "added" || record.adaptation === "modified");
    if (record.citationPresence !== undefined) {
      const citation = object(record.citationPresence);
      check(text(citation.error) || (bytes(citation.present) && bytes(citation.total)));
    }
  });
  const formatting = object(data.formatting);
  check(bytes(formatting.width) && Number(formatting.width) > 0);
  entries(formatting.results, (value, path) => {
    const result = object(value);
    if (result.state === "changed") {
      check(text(result.input));
      const file = object(result.file);
      strings(file, ["path", "formatted"]);
      check(file.path === path);
      check(file.mode === "100644" || file.mode === "100755");
    } else check(result.state === "current" || (result.state === "unavailable" && text(result.problem)));
  });
  const tasks = object(data.tasks);
  check(bool(tasks.decisionsRequired));
  check(text(tasks.problem));
  decodeQueue(tasks.queue);
  entries(tasks.errors, (value) => {
    check(text(value));
  });
  list(tasks.records, (value) => {
    const task = object(value);
    strings(task, ["reference", "title", "path", "contents", "digest", "planDigest"]);
    check(task.parent === undefined || text(task.parent));
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
  entries(data.upstreamDiffs, difference);
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
