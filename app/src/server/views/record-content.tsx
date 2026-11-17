import { formatTimestamp, isTimestamp } from "../presentation/date-time.js";
import type { ComponentChildren, JSX } from "preact";
import type { BrowserRecord } from "../../core/records/record-service.js";
import { metadataLabel } from "../../core/records/record-metadata.js";
import type { RecordLookup } from "../../core/records/record-lookup.js";
import { badge } from "./components.js";
import { recordURL } from "../routes/locations.js";
import { referenceLink } from "./record-links.js";
import type { WorkspaceView } from "../workspace/workspace-service.js";
import { reviewLocation, workflowRecordURL } from "../review/review-navigation.js";
import { experimentIsResult } from "../../core/experiments/experiment-workflow.js";
import { TaskLifecycle } from "../../core/tasks/task-workflow.js";

export function recordStatus(
  record: Pick<BrowserRecord, "id" | "type" | "status">,
  context: WorkspaceView,
): JSX.Element | null {
  if (record.type === "TSK") {
    const state = context.taskState(record.id);
    if (state === TaskLifecycle.AwaitingApproval)
      return (
        <a class="badge pending" href={workflowRecordURL(context, record.id)}>
          {state}
        </a>
      );
    if (state) return badge(state, state === TaskLifecycle.AwaitingAcceptance ? "pending" : undefined);
  }
  if (!record.status) return null;
  return badge(
    record.type === "EXP" && experimentIsResult(record.status)
      ? `Candidate: ${record.status.toLowerCase()}`
      : record.status,
  );
}
export function timeTag(value: string): JSX.Element {
  return (
    <time dateTime={value} data-local-time="" title={formatTimestamp(value)}>
      {formatTimestamp(value)}
    </time>
  );
}
export function addedAtTag(value?: string): JSX.Element | null {
  return value ? <span class="badge">Added {timeTag(value)}</span> : null;
}
export function recordRow(
  record: BrowserRecord,
  context: WorkspaceView,
  headingLevel: 2 | 3,
  href: string,
): JSX.Element {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article key={record.id} class="record-row" data-card="" data-record-id={record.id} tabIndex={-1}>
      {badge(record.id)}
      {record.type === "CHARTER" && record.collection && badge("Collection charter · context")}
      {record.local && badge("Local collection · read only")}
      {recordStatus(record, context)}
      {addedAtTag(record.addedAt)}
      {!record.local && context.hasPendingReview(record.path) && (
        <a class="badge pending" aria-label={record.id + ": Needs review"} href={reviewLocation(context, record)}>
          Needs review
        </a>
      )}
      {record.citationPresence &&
        ("error" in record.citationPresence
          ? badge("Document status unavailable", "pending")
          : badge(
              record.citationPresence.present
                ? String(record.citationPresence.present) +
                    "/" +
                    String(record.citationPresence.total) +
                    " documents present"
                : "No local document",
              record.citationPresence.present ? "approved" : "pending",
            ))}
      {record.adaptation && badge(record.adaptation === "modified" ? "Adapted" : "Added to collection", "pending")}
      <Heading>
        <a data-card-link="" href={href}>
          {record.title}
        </a>
      </Heading>
      {record.summary && <p class="muted">{record.summary}</p>}
      {record.previewError && (
        <p class="notice error" data-preview-error="">
          Preview unavailable: {record.previewError}
        </p>
      )}
    </article>
  );
}
export function recordList(
  records: BrowserRecord[],
  context: WorkspaceView,
  headingLevel: 2 | 3 = 2,
  location: (record: BrowserRecord) => string = (record) => recordURL(record.id),
): JSX.Element {
  return records.length ? (
    <div class="panel">{records.map((record) => recordRow(record, context, headingLevel, location(record)))}</div>
  ) : (
    <p class="empty">No matching records.</p>
  );
}
export function metadataValue(value: unknown, records: RecordLookup, depth = 0): JSX.Element {
  if (depth > 8) return <span>Nested metadata exceeds the display depth limit.</span>;
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((entry: unknown) => (
          <li>{metadataValue(entry, records, depth + 1)}</li>
        ))}
      </ul>
    );
  if (value !== null && typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([key, entry]: [string, unknown]) => (
          <>
            <dt>{metadataLabel(key)}</dt>
            <dd>{metadataValue(entry, records, depth + 1)}</dd>
          </>
        ))}
      </dl>
    );
  const text =
    value === null
      ? "Not set"
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
          ? String(value)
          : "Not provided";
  if (isTimestamp(text)) return timeTag(text);
  const referenced = records.record(text);
  if (referenced) return referenceLink(referenced, text);
  if (/^https?:\/\//i.test(text) && URL.canParse(text))
    return (
      <a href={text} rel="noreferrer noopener">
        {text}
      </a>
    );
  return <span class="metadata-text">{text}</span>;
}
export function metadataSection(heading: ComponentChildren, contents: ComponentChildren): JSX.Element {
  return (
    <section class="metadata-field">
      <h2>{heading}</h2>
      {contents}
    </section>
  );
}
export function metadataSections(fields: Record<string, unknown>, records: RecordLookup): JSX.Element | null {
  if (!Object.keys(fields).length) return null;
  return (
    <section class="record-metadata" aria-label="Record metadata">
      {Object.entries(fields).map(([key, value]) => metadataSection(metadataLabel(key), metadataValue(value, records)))}
    </section>
  );
}
