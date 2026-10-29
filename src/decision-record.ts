import { required } from "./invariants.js";
import { normalizedNumber } from "./record-identity.js";
import { readText } from "./files.js";
import { type Project } from "./project-model.js";
import { recordDocument } from "./record-document.js";
import { resolve } from "node:path";
import { markdownLinks } from "./markdown-links.js";

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
  const { metadata, body: contents } = recordDocument("ADR", decision.contents, decision.path);
  const body = [metadata.summary, metadata.agent_instruction ?? "", contents.split(/\r?\n/).slice(1).join("\n")]
    .join("\n\n")
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
  return markdownLinks(decision.contents).flatMap((href) => {
    const link = href.split(/[?#]/)[0];
    return !link || link.includes("://") || /^(mailto|data):/.test(link)
      ? []
      : [resolve(decision.path, "..", decodeURIComponent(link))];
  });
}

export function validateDecisionGraph(edges: ReadonlyMap<string, readonly string[]>): void {
  const active = new Set<string>(),
    done = new Set<string>();
  const visit = (reference: string): void => {
    if (active.has(reference)) throw new Error(`ADR reference cycle includes ${reference}`);
    if (done.has(reference)) return;
    active.add(reference);
    for (const target of edges.get(reference) ?? []) visit(target);
    active.delete(reference);
    done.add(reference);
  };
  for (const reference of edges.keys()) visit(reference);
}
