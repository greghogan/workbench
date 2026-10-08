import { required } from "./invariants.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizedNumber, readProjects, readText, rootOf, scan, type Project } from "./core.js";
import { recordTitle } from "./records.js";

import { recordDocument } from "./record-document.js";

export interface Decision {
  reference: string;
  path: string;
  title: string;
  summary: string;
  instruction: string | undefined;
  overrides: string[];
}
export interface DecisionScope {
  project: Project;
  directory: string;
  shared: boolean;
  decisions: Decision[];
}

export function readDecision(project: Project, number: string, path: string): Decision {
  const contents = readText(path);
  const { metadata } = recordDocument("ADR", contents, path);
  const summary = required(metadata.summary, "expected metadata.summary");
  const overrides = (metadata.overrides ?? []).map((value) => {
    const match = /^([a-z][a-z0-9_-]*):ADR-([0-9A-Z_]+)$/i.exec(value);
    if (!match?.[1] || !match[2]) throw new Error(`${path}: invalid overridden ADR '${value}'`);
    return `${match[1].toLowerCase()}:ADR-${normalizedNumber(match[2])}`;
  });
  if (new Set(overrides).size !== overrides.length) throw new Error(`${path}: duplicate overridden ADR`);
  return {
    reference: `${project.id}:ADR-${number}`,
    path,
    title: recordTitle("ADR", number, contents),
    summary,
    instruction: metadata.agent_instruction,
    overrides,
  };
}

/** Read canonical records directly; generated Markdown is never an input to context selection. */
export function decisionScopes(root: string): DecisionScope[] {
  const scopes: DecisionScope[] = [];
  const sharedRoot = join(root, ".workbench");
  for (const directory of existsSync(join(sharedRoot, "workbench/projects.toml")) ? [sharedRoot, root] : [root]) {
    const projects = readProjects(directory);
    for (const project of directory === root ? projects : projects.slice(0, 1)) {
      const scopeRoot = rootOf(directory, project);
      scopes.push({
        project,
        directory: scopeRoot,
        shared: directory !== root,
        decisions: scan(scopeRoot, "ADR").map((record) => readDecision(project, record.number, record.path)),
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
        if (
          target.scope !== scope &&
          !(!scope.shared && target.scope.shared) &&
          !(target.scope.project.path === "." && !scope.shared) &&
          !(!scope.shared && scope.project.path.startsWith(`${target.scope.project.path}/`))
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
  return scopes;
}
