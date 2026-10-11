import { required } from "./invariants.js";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { distributionRoot, readProjects, relativeRecordPath, rootOf, scan, type Project } from "./core.js";

import { linkedDecisionPaths, readDecision, referencedDecisions, type Decision } from "./decision-record.js";
import { appliesWithin, hasCollectionProject, resolveCollections, type CollectionSelection } from "./collections.js";
import type { CollectionIdentity } from "./collection-schema.js";

export interface DecisionScope {
  project: Project;
  directory: string;
  shared: boolean;
  decisions: Decision[];
  appliesTo: string[];
  source?: CollectionIdentity;
  dependencies?: string[];
  distribution?: boolean;
  local?: boolean;
}

/** Read canonical records directly; generated Markdown is never an input to context selection. */
export function decisionScopes(root: string, includeLocal = true, selection?: CollectionSelection): DecisionScope[] {
  const scopes: DecisionScope[] = [];
  const sharedRoot = join(root, ".workbench");
  const directories = hasCollectionProject(root)
    ? existsSync(join(sharedRoot, "workbench/projects.toml"))
      ? [sharedRoot, root]
      : [root]
    : [distributionRoot(root)];
  for (const directory of directories) {
    const projects = readProjects(directory);
    for (const project of directory === root ? projects : projects.slice(0, 1)) {
      const scopeRoot = rootOf(directory, project);
      scopes.push({
        project,
        directory: scopeRoot,
        shared: directory !== root,
        appliesTo: [directory === root ? project.path : "."],
        distribution: realpathSync(scopeRoot) === distributionRoot(root),
        decisions: scan(scopeRoot, "ADR").map((record) => readDecision(project, record.number, record.path)),
      });
    }
  }
  const collections = resolveCollections(root, includeLocal, selection);
  for (const collection of collections) {
    for (const namespace of collection.manifest.namespace) {
      const directory = rootOf(collection.directory, { id: namespace.id, path: namespace.path });
      const project = { id: namespace.id, path: namespace.path };
      const localIndex = scopes.findIndex((scope) => !scope.shared);
      scopes.splice(localIndex < 0 ? scopes.length : localIndex, 0, {
        project,
        directory,
        shared: true,
        local: !!collection.local,
        appliesTo: collection.pin.scopes,
        source: {
          id: collection.pin.id,
          revision: collection.pin.revision,
          sha256: collection.pin.sha256,
          visibility: collection.pin.visibility,
        },
        dependencies: collection.manifest.dependency.map((dependency) => dependency.id),
        decisions: namespace.decisions.map((number) => {
          const name = [
            namespace.path === "." ? "" : namespace.path,
            "workbench",
            relativeRecordPath("ADR", number).split(sep).join("/"),
          ]
            .filter(Boolean)
            .join("/");
          return readDecision(
            project,
            number,
            join(directory, "workbench", relativeRecordPath("ADR", number)),
            required(collection.files.get(name), "verified collection decision").toString("utf8"),
          );
        }),
      });
    }
  }
  const byReference = new Map<string, { decision: Decision; scope: DecisionScope }>();
  const scopeIds = new Set<string>();
  for (const scope of scopes) {
    if (scopeIds.has(scope.project.id)) throw new Error(`shared and local project IDs collide: ${scope.project.id}`);
    scopeIds.add(scope.project.id);
    for (const decision of scope.decisions) byReference.set(decision.reference, { decision, scope });
  }
  for (const scope of scopes) {
    const replacements = new Set<string>();
    for (const decision of scope.decisions) {
      for (const reference of decision.overrides) {
        const target = byReference.get(reference);
        if (!target) throw new Error(`${decision.path}: overridden ADR not found: ${reference}`);
        if (!scope.local && target.scope.local)
          throw new Error(`${decision.path}: shared decisions cannot override local installations: ${reference}`);
        if (
          target.scope !== scope &&
          !(
            scope.appliesTo.every((path) => target.scope.appliesTo.some((parent) => appliesWithin(parent, path))) &&
            (!scope.shared ||
              (scope.source &&
                (target.scope.shared || target.scope.distribution) &&
                (!target.scope.source || scope.dependencies?.includes(target.scope.source.id))))
          )
        )
          throw new Error(`${decision.path}: cannot override an ADR outside the same or an inherited scope`);
        if (replacements.has(reference)) throw new Error(`${decision.path}: competing replacements for ${reference}`);
        replacements.add(reference);
      }
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(reference: string): void {
    if (active.has(reference)) throw new Error(`ADR override cycle includes ${reference}`);
    if (visited.has(reference)) return;
    active.add(reference);
    for (const target of required(byReference.get(reference), "expected byReference.get(reference)").decision.overrides)
      visit(target);
    active.delete(reference);
    visited.add(reference);
  }
  for (const reference of byReference.keys()) visit(reference);
  validateDecisionReferences(scopes);
  return scopes;
}

/** Qualified references retain identity; source order never gives a later local ADR foundational authority. */
function validateDecisionReferences(scopes: DecisionScope[]): void {
  const records = new Map(
    scopes.flatMap((scope) => scope.decisions.map((decision) => [decision.reference, { scope, decision }] as const)),
  );
  const edges = new Map<string, string[]>();
  const byPath = new Map([...records].map(([reference, { decision }]) => [resolve(decision.path), reference]));
  for (const scope of scopes) {
    const map = join(scope.directory, "workbench/decision-map.md");
    if (scope.source && !existsSync(map)) throw new Error(`${scope.source.id}: exported decision map is missing`);
    for (const decision of scope.decisions) {
      const links: string[] = [];
      for (const reference of [
        ...referencedDecisions(decision),
        ...linkedDecisionPaths(decision).flatMap((path) => {
          const reference = byPath.get(path);
          return reference ? [reference] : [];
        }),
      ]) {
        links.push(reference);
        const target = records.get(reference);
        if (!target) throw new Error(`${decision.path}: ADR reference not found: ${reference}`);
        if (!scope.local && target.scope.local)
          throw new Error(`${decision.path}: shared decisions cannot depend on local installations: ${reference}`);
        if (target.scope === scope) {
          const number = reference.split("ADR-")[1] ?? "";
          const own = decision.reference.split("ADR-")[1] ?? "";
          if (number.length > own.length || (number.length === own.length && number >= own))
            throw new Error(`${decision.path}: ADR references must name an earlier decision: ${reference}`);
        } else if (
          (scope.source && !target.scope.shared && !target.scope.distribution) ||
          !scope.appliesTo.every((path) => target.scope.appliesTo.some((parent) => appliesWithin(parent, path))) ||
          (scope.source &&
            target.scope.source &&
            scope.source.id !== target.scope.source.id &&
            !scope.dependencies?.includes(target.scope.source.id))
        )
          throw new Error(
            `${decision.path}: ADR reference outside applicable scope or declared dependencies: ${reference}`,
          );
      }
      edges.set(decision.reference, links);
      if (scope.source) {
        if (/\b[a-z][a-z0-9_-]*:(?:TSK|EXP|ENV|CIT|REL)-[0-9a-z_]+\b/i.test(decision.contents))
          throw new Error(`${scope.source.id}: collection references a record type that is not exported`);
        const allowed = new Set(
          scopes
            .filter(
              (candidate) =>
                candidate.source?.id === scope.source?.id || scope.dependencies?.includes(candidate.source?.id ?? ""),
            )
            .flatMap((candidate) => [
              join(candidate.directory, "workbench/decision-map.md"),
              ...candidate.decisions.map((entry) => entry.path),
            ])
            .map((path) => resolve(path)),
        );
        for (const target of linkedDecisionPaths(decision)) {
          if (!allowed.has(target)) throw new Error(`${scope.source.id}: exported ADR links outside selected records`);
        }
      }
    }
  }
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (reference: string) => {
    if (active.has(reference)) throw new Error(`ADR reference cycle includes ${reference}`);
    if (done.has(reference)) return;
    active.add(reference);
    for (const target of edges.get(reference) ?? []) visit(target);
    active.delete(reference);
    done.add(reference);
  };
  for (const reference of records.keys()) visit(reference);
  // Independent collections cannot both replace a rule on an overlapping project scope.
  for (const [index, scope] of scopes.entries())
    if (scope.source)
      for (const other of scopes.slice(index + 1))
        if (
          other.source &&
          other.source.id !== scope.source.id &&
          scope.appliesTo.some((path) =>
            other.appliesTo.some((otherPath) => appliesWithin(path, otherPath) || appliesWithin(otherPath, path)),
          )
        ) {
          const targets = new Set(scope.decisions.flatMap((decision) => decision.overrides));
          if (other.decisions.some((decision) => decision.overrides.some((reference) => targets.has(reference))))
            throw new Error("competing replacements in overlapping collection scopes");
        }
}
