import { parseDocument, stringify } from "yaml";
import type { Kind } from "./core.js";

export type ProseKind = Exclude<Kind, "CIT" | "REL">;
export interface Metadata {
  summary?: string;
  agent_instruction?: string;
  overrides?: string[];
  status?: string;
  parent?: string | null;
  depends_on?: string[];
  environment?: string | null;
  extensions?: Record<string, unknown>;
}
export const taskStatuses = ["Planned", "Active", "Blocked", "Done", "Canceled"];
export const experimentStatuses = ["Running", "Accepted", "Rejected", "Inconclusive"];
export const terminalTask = new Set(["Done", "Canceled"]);

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function oneLine(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !/[\r\n]/.test(value);
}
function reference(value: unknown, kind: Kind): boolean {
  return typeof value === "string" && new RegExp(`^[a-z][a-z0-9_-]*:${kind}-[0-9a-z_]+$`, "i").test(value);
}
const references =
  (kind: Kind) =>
  (value: unknown): boolean =>
    Array.isArray(value) && value.every((entry: unknown) => reference(entry, kind));
interface Field {
  required?: boolean;
  valid: (value: unknown) => boolean;
  description: string;
}
const fields: Record<ProseKind, Record<string, Field>> = {
  ADR: {
    summary: { required: true, valid: oneLine, description: "one nonempty logical line" },
    agent_instruction: { valid: oneLine, description: "one nonempty logical line" },
    overrides: { valid: references("ADR"), description: "an array of scoped ADR references" },
  },
  TSK: {
    status: {
      required: true,
      valid: (value) => typeof value === "string" && taskStatuses.includes(value),
      description: taskStatuses.join(", "),
    },
    parent: {
      required: true,
      valid: (value) => value === null || reference(value, "TSK"),
      description: "null or a scoped TSK reference",
    },
    depends_on: { required: true, valid: references("TSK"), description: "an array of scoped TSK references" },
  },
  EXP: {
    status: {
      required: true,
      valid: (value) => typeof value === "string" && experimentStatuses.includes(value),
      description: experimentStatuses.join(", "),
    },
    environment: {
      required: true,
      valid: (value) => value === null || reference(value, "ENV"),
      description: "null or a scoped ENV reference",
    },
  },
  ENV: {},
};

export function splitFrontmatter(contents: string): { yaml: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?\n)?---(?:\r?\n|$)/.exec(contents);
  if (!match) return undefined;
  return { yaml: match[1] ?? "", body: contents.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)*/, "") };
}

/** Syntax parsing is independent of completeness: incomplete drafts can still be formatted. */
export function parseProseRecord(contents: string, path: string): { metadata: Record<string, unknown>; body: string } {
  const parts = splitFrontmatter(contents);
  if (!parts) throw new Error(`${path}: expected YAML frontmatter delimited by ---`);
  const document = parseDocument(parts.yaml);
  if (document.errors.length)
    throw new Error(`${path}: invalid frontmatter: ${document.errors.map((error) => error.message).join("; ")}`);
  const metadata: unknown = document.toJS();
  if (!mapping(metadata)) throw new Error(`${path}: frontmatter must be a YAML mapping`);
  return { metadata, body: parts.body };
}

export function recordDocument(kind: ProseKind, contents: string, path: string): { metadata: Metadata; body: string } {
  const { metadata, body } = parseProseRecord(contents, path);
  const schema: Record<string, Field> = {
    ...fields[kind],
    extensions: { valid: mapping, description: "a mapping of project-specific metadata" },
  };
  for (const key of Object.keys(metadata)) {
    if (!Object.hasOwn(schema, key))
      throw new Error(`${path}: unknown ${kind} metadata '${key}'; custom fields belong in 'extensions'`);
  }
  for (const [name, field] of Object.entries(schema)) {
    if (!Object.hasOwn(metadata, name) && !field.required) continue;
    if (!field.valid(metadata[name])) throw new Error(`${path}: '${name}' must be ${field.description}`);
  }
  return { metadata, body };
}

export function renderProseRecord(metadata: Metadata, body: string): string {
  return `---\n${stringify(metadata)}---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}
