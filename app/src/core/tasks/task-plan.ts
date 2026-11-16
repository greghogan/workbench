import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import { parseProseRecord } from "../records/record-document.js";

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
const approvalParser = new MarkdownIt({ html: false, linkify: false, typographer: false });
approvalParser.renderer.rules.softbreak = () => " ";

/** Prose layout is separate from plan scope; literal code, links, breaks, and block structure remain significant. */
function canonicalPlan(contents: string): string {
  const tokens = approvalParser.parse(contents, {});
  const fences: string[] = [];
  const normalize = (items: typeof tokens) => {
    for (const token of items) {
      if (token.type === "paragraph_open" || token.type === "paragraph_close") token.hidden = false;
      if (token.type === "text") token.content = token.content.replace(/\s+/g, " ");
      if (token.type === "fence") fences.push(token.info.trim());
      if (token.children) normalize(token.children);
    }
  };
  normalize(tokens);
  return JSON.stringify([approvalParser.renderer.render(tokens, approvalParser.options, {}), fences]);
}
/** Delivery accounts and completed checkboxes record execution, without authorizing a changed plan. */
function planParts(contents: string) {
  const { metadata, body } = parseProseRecord(contents, "task plan"),
    lines = body.split("\n"),
    tokens = parser.parse(body, {}),
    removed = new Set<number>();
  let listDepth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index],
      title = tokens[index + 1];
    if (token?.type === "list_item_open") listDepth++;
    if (token?.type === "list_item_close") listDepth--;
    if (listDepth && token?.type === "inline" && token.map && /^\[[xX ]\]\s/.test(token.content)) {
      const row = token.map[0],
        line = lines[row];
      if (line !== undefined)
        lines[row] = line
          .replace(/^(\s*(?:[-+*]|\d+[.)])\s+\[)[xX](\]\s)/, "$1 $2")
          .replace(
            /^(\s*[-+*] \[ \] [a-z][a-z0-9_-]*:TSK-[0-9A-Z]+)(?: \((?:Planned|Approved|Accepted|Canceled)\))?/i,
            "$1",
          );
    }
    if (
      token?.type !== "heading_open" ||
      token.level !== 0 ||
      title?.content !== "Implementation account" ||
      !token.map
    )
      continue;
    const level = Number(token.tag.slice(1));
    let end = lines.length;
    for (let next = index + 2; next < tokens.length; next++) {
      const candidate = tokens[next];
      if (
        candidate?.type === "heading_open" &&
        candidate.level === 0 &&
        Number(candidate.tag.slice(1)) <= level &&
        candidate.map
      ) {
        end = candidate.map[0];
        break;
      }
    }
    for (let line = token.map[0]; line < end; line++) removed.add(line);
  }
  const plan = lines
    .filter((_, index) => !removed.has(index))
    .join("\n")
    .replace(/^# TSK-[0-9A-Za-z]+: /m, "# ")
    .trim();
  return {
    metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "status" && key !== "added_at")),
    plan,
  };
}
type PlanFiles = readonly { name: string; contents: string; executable: boolean }[];
function planDigest(contents: string, files: PlanFiles, normalize: (text: string) => string): string {
  const { metadata, plan } = planParts(contents);
  return createHash("sha256")
    .update(
      JSON.stringify([
        metadata,
        normalize(plan),
        ...(files.length ? [[...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))] : []),
      ]),
    )
    .digest("hex");
}

/** Verification retains its existing source binding, independently of formatting-tolerant human plan approval. */
export const taskPlanDigest = (contents: string, files: PlanFiles = []): string =>
  planDigest(contents, files, (text) => text);
export const taskPlanApprovalDigest = (contents: string, files: PlanFiles = []): string =>
  planDigest(contents, files, canonicalPlan);

/** Delivery notes remain outside the human-approved plan, including when later sections follow the account. */
export function appendTaskAccount(contents: string, entry: string): string {
  const { body } = parseProseRecord(contents, "task account"),
    tokens = parser.parse(body, {}),
    lines = body.split("\n");
  for (let index = 0; index < tokens.length; index++) {
    const heading = tokens[index];
    if (
      heading?.type !== "heading_open" ||
      heading.level !== 0 ||
      tokens[index + 1]?.content !== "Implementation account" ||
      !heading.map
    )
      continue;
    const level = Number(heading.tag.slice(1));
    let end = lines.length;
    for (let next = index + 2; next < tokens.length; next++) {
      const candidate = tokens[next];
      if (
        candidate?.type === "heading_open" &&
        candidate.level === 0 &&
        Number(candidate.tag.slice(1)) <= level &&
        candidate.map
      ) {
        end = candidate.map[0];
        break;
      }
    }
    lines.splice(end, 0, "", entry.trim(), "");
    return contents.slice(0, contents.length - body.length) + lines.join("\n");
  }
  return contents.trimEnd() + `\n\n## Implementation account\n\n${entry.trim()}\n`;
}
