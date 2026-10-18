import { policyFilesHash } from "./collection-files.js";
import { join, resolve } from "node:path";
import { readProjects, rootOf, scan, scanRecordDirectory, type Project } from "./core.js";

import { linkedDecisionPaths, readDecision, referencedDecisions, type Decision } from "./decision-record.js";
import {
  appliesWithin,
  hasCollectionProject,
  resolveCollections,
  resolveLocalCollections,
  type ResolvedCollection,
  type CollectionSelection,
} from "./collections.js";
import type { CollectionIdentity } from "./collection-schema.js";

export interface DecisionScope {
  project: Project;
  directory: string;
  recordsDirectory: string;
  shared: boolean;
  decisions: Decision[];
  appliesTo: string[];
  source?: CollectionIdentity;
  dependencies?: string[];
  distribution?: boolean;
  local?: boolean;
}

/** Read project-owned copies, never the upstream snapshot or the executable's policies. */
export function decisionScopes(root: string, includeLocal = true, selection?: CollectionSelection): DecisionScope[] {
  const scopes: DecisionScope[] = [];
  if (hasCollectionProject(root)) {
    for (const project of readProjects(root)) {
      const directory = rootOf(root, project);
      scopes.push({
        project,
        directory,
        recordsDirectory: join(directory, "workbench"),
        shared: false,
        appliesTo: [project.path],
        decisions: scan(directory, "ADR").map((record) => readDecision(project, record.number, record.path)),
      });
    }
  }
  const collections = resolveCollections(root, includeLocal, selection);
  scopes.push(...collectionDecisionScopes(collections));
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (ids.has(scope.project.id)) throw new Error(`project and collection namespace collision: ${scope.project.id}`);
    ids.add(scope.project.id);
  }
  validateDecisionReferences(scopes);
  return scopes;
}

export function collectionDecisionScopes(collections: ResolvedCollection[]): DecisionScope[] {
  const scopes: DecisionScope[] = [];
  for (const collection of collections) {
    const project = { id: collection.pin.id, path: "." };
    const recordsDirectory = collection.local ? join(collection.directory, "workbench") : collection.directory;
    scopes.push({
      project,
      directory: collection.directory,
      recordsDirectory,
      shared: true,
      local: collection.local,
      appliesTo: collection.pin.scopes,
      source: {
        id: collection.pin.id,
        revision: collection.pin.revision,
        sha256: collection.pin.sha256,
        visibility: collection.pin.visibility,
      },
      decisions: scanRecordDirectory(recordsDirectory, "ADR").map((record) =>
        readDecision(project, record.number, record.path),
      ),
    });
  }
  return scopes;
}

export function localDecisionScopes(root: string): DecisionScope[] {
  const collections = resolveLocalCollections(root);
  const selected = collections.filter((collection, index) => {
    const previous = collections.find((entry) => entry.pin.id === collection.pin.id);
    if (previous && policyFilesHash(previous.files) !== policyFilesHash(collection.files))
      throw new Error(`conflicting local collection namespace: ${collection.pin.id}`);
    return collections.findIndex((entry) => entry.pin.id === collection.pin.id) === index;
  });
  const scopes = collectionDecisionScopes(selected);
  validateDecisionReferences(scopes);
  return scopes;
}

/** Qualified references retain identity; source order never gives a later local ADR foundational authority. */
function validateDecisionReferences(scopes: DecisionScope[]): void {
  const records = new Map(
    scopes.flatMap((scope) => scope.decisions.map((decision) => [decision.reference, { scope, decision }] as const)),
  );
  const byPath = new Map([...records].map(([reference, { decision }]) => [resolve(decision.path), reference]));
  const edges = new Map<string, string[]>();
  for (const scope of scopes)
    for (const decision of scope.decisions) {
      const references = [
        ...referencedDecisions(decision),
        ...linkedDecisionPaths(decision).flatMap((path) => byPath.get(path) ?? []),
      ];
      for (const reference of references) {
        const target = records.get(reference);
        if (!target) throw new Error(`${decision.path}: ADR reference not found: ${reference}`);
        if (!scope.local && target.scope.local)
          throw new Error(`${decision.path}: project decisions cannot depend on machine-local policy`);
        if (target.scope === scope) {
          const own = decision.reference.split("ADR-")[1] ?? "";
          const number = reference.split("ADR-")[1] ?? "";
          if (number.length > own.length || (number.length === own.length && number >= own))
            throw new Error(`${decision.path}: ADR references must name an earlier decision: ${reference}`);
        } else if (
          !scope.appliesTo.every((path) => target.scope.appliesTo.some((parent) => appliesWithin(parent, path)))
        )
          throw new Error(`${decision.path}: ADR reference outside applicable scope: ${reference}`);
      }
      edges.set(decision.reference, references);
    }
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (reference: string): void => {
    if (active.has(reference)) throw new Error(`ADR reference cycle includes ${reference}`);
    if (done.has(reference)) return;
    active.add(reference);
    for (const target of edges.get(reference) ?? []) visit(target);
    active.delete(reference);
    done.add(reference);
  };
  for (const reference of records.keys()) visit(reference);
}
