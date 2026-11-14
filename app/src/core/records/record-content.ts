import { recordDocument, recordTitle, type ProseKind } from "./record-document.js";
import MarkdownIt from "markdown-it";
const parser = new MarkdownIt({ html: true });

export const requiredExperimentProtocol = [
  "Hypothesis",
  "Candidate and baseline",
  "Independent variable",
  "Controls and correctness",
  "Workload",
  "Evaluation rule",
];
export function section(contents: string, heading: string): boolean {
  const tokens = parser.parse(contents, {});
  const index = tokens.findIndex(
    (token, index) =>
      token.type === "heading_open" &&
      token.tag === "h2" &&
      token.level === 0 &&
      tokens[index + 1]?.content === heading,
  );
  if (index < 0) return false;
  for (let position = index + 3; position < tokens.length; position++) {
    const token = tokens[position];
    if (!token) continue;
    if (token.type === "heading_open") {
      if (token.level === 0 && Number(token.tag.slice(1)) <= 2) return false;
      position += 2;
    } else if (
      (token.type === "html_block" ? token.content.split(/<!--[\s\S]*?-->/g) : [token.content]).some(
        (fragment) => fragment.trim().length > 0,
      )
    )
      return true;
  }
  return false;
}

export function proseRecordErrors(kind: ProseKind, number: string, path: string, contents: string): string[] {
  const errors: string[] = [];
  const { metadata, body } = recordDocument(kind, contents, path);
  recordTitle(kind, number, contents);
  if (kind === "EXP") {
    for (const heading of requiredExperimentProtocol)
      if (!section(body, heading)) errors.push(`${path}: missing or empty ## ${heading}`);
    if (["Accepted", "Rejected", "Inconclusive"].includes(metadata.status ?? ""))
      for (const heading of ["Execution provenance", "Evidence", "Decision"])
        if (!section(body, heading)) errors.push(`${path}: completed experiment needs ## ${heading}`);
  }
  if (kind === "ENV" && !section(body, "Hardware configuration"))
    errors.push(`${path}: missing or empty ## Hardware configuration`);
  return errors;
}
