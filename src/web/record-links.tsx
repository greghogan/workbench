import type { JSX } from "preact";
import type { BrowserRecord } from "../record-service.js";
import { recordURL } from "./locations.js";
export function referenceAttributes(record: BrowserRecord): Record<string, string> {
  return {
    "data-record-reference": record.id,
    "data-record-title": record.title.slice(0, 512),
    "data-record-summary": record.summary.slice(0, 1200),
  };
}
export function referenceLink(record: BrowserRecord, label: string): JSX.Element {
  return (
    <a href={recordURL(record.id)} {...referenceAttributes(record)}>
      {label}
    </a>
  );
}
