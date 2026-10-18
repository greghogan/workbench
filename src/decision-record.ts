import { required } from "./invariants.js";
import { normalizedNumber, readText, type Project } from "./core.js";
import { recordDocument } from "./record-document.js";
import { resolve } from "node:path";

export interface Decision {
  reference: string;
  path: string;
  title: string;
  summary: string;
  instruction: string | undefined;
  contents: string;
}
export function readDecision(project: Project, number: string, path: string, contents = readText(path)): Decision {
  const { metadata, body } = recordDocument("ADR", contents, path);
  const prefix = `# ADR-${normalizedNumber(number)}: `;
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith(prefix) || !first.slice(prefix.length).trim())
    throw new Error(`invalid title for ADR-${number}`);
  const summary = required(metadata.summary, "expected metadata.summary");
  return {
    contents,
    reference: `${project.id}:ADR-${number}`,
    path,
    title: first.slice(prefix.length),
    summary,
    instruction: metadata.agent_instruction,
  };
}

export function referencedDecisions(decision: Decision): string[] {
  const namespace = decision.reference.split(":")[0] ?? "";
  const body = recordDocument("ADR", decision.contents, decision.path)
    .body.split(/\r?\n/)
    .slice(1)
    .join("\n")
    .replace(/\]\([^)]+\)/g, "]");
  return [
    ...[...body.matchAll(/\b(?:([a-z][a-z0-9_-]*):)?ADR-([0-9a-z_]+)\b/gi)].map(
      (match) =>
        `${(match[1] ?? namespace).toLowerCase()}:ADR-${normalizedNumber(required(match[2], "reference number"))}`,
    ),
  ];
}

/** Link destinations retain their filesystem ownership rather than inheriting the surrounding namespace. */
export function linkedDecisionPaths(decision: Pick<Decision, "path" | "contents">): string[] {
  return [...decision.contents.matchAll(/\]\(([^)]+)\)/g)].flatMap((match) => {
    const link = match[1]?.trim().replace(/^<|>$/g, "").split("#")[0];
    return !link || link.includes("://") || /^(mailto|data):/.test(link)
      ? []
      : [resolve(decision.path, "..", decodeURIComponent(link))];
  });
}
