import { normalizedNumber, parseReference } from "./core.js";
import { decisionScopes } from "./decisions.js";
import type { CollectionIdentity } from "./collection-schema.js";

/** Only ADRs integrate from policy sources; other records remain project-owned. */
export function resolveRecordReference(
  root: string,
  reference: string,
): ReturnType<typeof parseReference> & {
  contents?: string;
  source?: CollectionIdentity;
  scopes?: string[];
  installation?: "local" | "project";
} {
  const match = /^([a-z][a-z0-9_-]*):ADR-([0-9a-z_]+)$/i.exec(reference);
  if (!match?.[1] || !match[2]) return parseReference(root, reference);
  const id = match[1].toLowerCase();
  const number = normalizedNumber(match[2]);
  const scope = decisionScopes(root).find((entry) => entry.project.id === id);
  const decision = scope?.decisions.find((entry) => entry.reference === `${id}:ADR-${number}`);
  if (!scope || !decision) throw new Error(`ADR reference not found: ${reference}`);
  return {
    project: scope.project,
    kind: "ADR",
    number,
    path: decision.path,
    contents: decision.contents,
    ...(scope.source
      ? {
          source: scope.source,
          scopes: scope.appliesTo,
          installation: scope.local ? ("local" as const) : ("project" as const),
        }
      : {}),
  };
}
