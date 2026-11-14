import type { BrowserRecord } from "./record-service.js";
import { markdownExcerpt } from "./markdown-excerpt.js";
import { parseProseRecord, recordTimestamp } from "./record-document.js";
import { citationDateFields as dateFields, citationDateText } from "../citations/citation-dates.js";
import type { Kind } from "./record-identity.js";

/** Presentation only: record validation and persisted field names remain owned by their schemas. */
export const recordPresentations = {
  CHARTER: { label: "Charters", format: "markdown", editable: true },
  ADR: { label: "Decisions", format: "markdown", editable: true },
  TSK: { label: "Tasks", format: "markdown", editable: false },
  ENV: { label: "Environments", format: "markdown", editable: false },
  EXP: { label: "Experiments", format: "markdown", editable: false },
  CIT: { label: "Citations", format: "citation", editable: false },
  REL: { label: "Releases", format: "yaml", editable: false },
} as const satisfies Record<Kind | "CHARTER", { label: string; format: string; editable: boolean }>;
export const recordTypes = Object.keys(recordPresentations) as (keyof typeof recordPresentations)[];
import { parseDocument } from "yaml";

export const metadataLabels: Record<string, string> = {
  summary: "Summary",
  agent_instruction: "Agent instructions",
  status: "Status",
  parent: "Parent task",
  depends_on: "Dependencies",
  environment: "Environment",
  extensions: "Additional metadata",
  "container-title": "Publication",
  "collection-title": "Series",
  "event-title": "Event",
  "publisher-place": "Publisher location",
  URL: "URL",
  DOI: "DOI",
  ISBN: "ISBN",
  ISSN: "ISSN",
  issued: "Published",
  accessed: "Accessed",
  released: "Released",
  yanked: "Yanked",
  revision: "Revision",
  artifacts: "Artifacts",
  notes: "Notes",
  version: "Version",
  tag: "Tag",
  author: "Authors",
  editor: "Editors",
  abstract: "Abstract",
  type: "Type",
  id: "Source identifier",
  page: "Pages",
};
export const metadataLabel = (key: string): string =>
  (Object.hasOwn(metadataLabels, key) ? metadataLabels[key] : undefined) ??
  key.replaceAll(/[_-]/g, " ").replace(/^./, (value) => value.toUpperCase());
export function metadataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): string => (typeof value === "string" ? value : "");
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((name: unknown) => {
    if (!metadataObject(name)) return [];
    const label =
      text(name.literal) ||
      [text(name.given), text(name["non-dropping-particle"]), text(name.family), text(name.suffix)]
        .filter(Boolean)
        .join(" ");
    return label ? [label] : [];
  });
}
const citationDateFields = new Set<string>(dateFields.filter((field) => field !== "issued"));
const citationFields = [
  "container-title",
  "publisher",
  "publisher-place",
  "volume",
  "issue",
  "page",
  "DOI",
  "URL",
  "abstract",
  "type",
  "id",
  "ISBN",
  "ISSN",
  "collection-title",
  "event-title",
  ...citationDateFields,
];
const citationKnownFields = new Set(["title", "author", "editor", "issued", ...citationFields]);

/** Display incomplete CSL drafts without weakening citation validation. */
export function citationMetadata(contents: string): {
  title: string;
  summary: string;
  fields: Record<string, unknown>;
} {
  const value: unknown = JSON.parse(contents);
  if (!Array.isArray(value) || value.length !== 1 || !metadataObject(value[0]))
    throw new Error("expected one CSL-JSON citation");
  const citation = value[0];
  const authors = names(citation.author),
    editors = names(citation.editor);
  const date = citationDateText(citation.issued, true);
  const fields: Record<string, unknown> = {};
  if (authors.length) fields.Authors = authors;
  if (editors.length) fields.Editors = editors;
  if (date) fields[/^-?\d+(?:–-?\d+)?$/.test(date) ? "Year" : "Published"] = date;
  for (const key of citationFields) {
    const value = citationDateFields.has(key) ? citationDateText(citation[key]) : citation[key];
    if (value !== undefined) fields[metadataLabel(key)] = value;
  }
  const additional = Object.fromEntries(Object.entries(citation).filter(([key]) => !citationKnownFields.has(key)));
  if (Object.keys(additional).length) fields["Additional metadata"] = additional;
  return {
    title: text(citation.title),
    summary: [
      authors.join(", ") || (editors.length ? `${editors.join(", ")} (editors)` : ""),
      date,
      text(citation["container-title"]) || text(citation.publisher),
    ]
      .filter(Boolean)
      .join(" · "),
    fields,
  };
}
export function yamlMetadata(contents: string): Record<string, unknown> {
  const document = parseDocument(contents);
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  const value: unknown = document.toJS();
  if (!metadataObject(value)) throw new Error("expected metadata fields");
  return value;
}

export function describeRecord(record: BrowserRecord, contents: string): void {
  const type = record.type;
  record.title = /^#\s+(.+)$/m.exec(contents)?.[1] ?? record.title;
  if (type === "CIT") {
    const citation = citationMetadata(contents);
    record.title = citation.title || record.title;
    record.summary = citation.summary;
  } else if (type === "REL") {
    const release = yamlMetadata(contents);
    if (typeof release.version === "string") record.title = `Release ${release.version}`;
    record.summary = [release.tag, release.released, release.yanked === true ? "Yanked" : undefined]
      .filter((value) => typeof value === "string")
      .join(" · ");
  } else if (type === "CHARTER") {
    record.summary = markdownExcerpt(contents);
  } else if (["ADR", "TSK", "EXP", "ENV"].includes(type)) {
    const { metadata, body } = parseProseRecord(contents, record.path);
    if (typeof metadata.summary === "string") record.summary = markdownExcerpt(metadata.summary);
    else record.summary = markdownExcerpt(body);
    if (typeof metadata.status === "string") record.status = metadata.status;
    if (recordTimestamp(metadata.added_at)) record.addedAt = metadata.added_at;
  }
  record.title = record.title.slice(0, 512);
  record.summary = record.summary.slice(0, 512);
  record.status = record.status.slice(0, 128);
}
