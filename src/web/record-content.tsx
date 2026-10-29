import type { JSX } from "preact";
import type { BrowserRecord } from "../record-service.js";
import { metadataLabel } from "../record-metadata.js";
import type { RecordLookup } from "../record-lookup.js";
import { badge } from "./components.js";
import { recordURL } from "./locations.js";
import { referenceLink } from "./record-links.js";
export function recordList(records: BrowserRecord[]): JSX.Element {
  return records.length ? (
    <section class="panel" aria-label="Records">
      {records.map((record) => (
        <article class="record-row" data-record-id={record.id} tabIndex={-1}>
          {badge(record.id)}
          {record.type === "CHARTER" && record.collection && badge("Collection charter · context")}
          {record.local && badge("Local collection · read only")}
          {record.status && badge(record.status)}
          {record.citationPresence &&
            ("error" in record.citationPresence
              ? badge("Document status unavailable", "pending")
              : badge(
                  record.citationPresence.present
                    ? String(record.citationPresence.present) +
                        "/" +
                        String(record.citationPresence.total) +
                        " PDFs present"
                    : "No local PDF",
                  record.citationPresence.present ? "approved" : "pending",
                ))}
          {record.adaptation && badge(record.adaptation === "modified" ? "Adapted" : "Added to collection", "pending")}
          <h2>
            <a href={recordURL(record.id)}>{record.title}</a>
          </h2>
          {record.summary && <p class="muted">{record.summary}</p>}
          {record.previewError && (
            <p class="notice error" data-preview-error="">
              Preview unavailable: {record.previewError}
            </p>
          )}
        </article>
      ))}
    </section>
  ) : (
    <p class="empty">No matching records.</p>
  );
}
export function metadataValue(value: unknown, records: RecordLookup, depth = 0): JSX.Element {
  if (depth > 8) return <span>Nested metadata; see Source for the complete value.</span>;
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
export function metadataSections(fields: Record<string, unknown>, records: RecordLookup): JSX.Element | null {
  if (!Object.keys(fields).length) return null;
  return (
    <section class="record-metadata" aria-label="Record metadata">
      {Object.entries(fields).map(([key, value]) => (
        <section>
          <h2>{metadataLabel(key)}</h2>
          {metadataValue(value, records)}
        </section>
      ))}
    </section>
  );
}
