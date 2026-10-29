import { required } from "./invariants.js";
import { existsSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readText } from "./files.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { decisionScopes, localDecisionScopes, type DecisionScope } from "./decisions.js";
import { wrap } from "./formatting.js";
import { hasCollectionProject } from "./collections.js";
import { readConfig } from "./project-configuration.js";
import { markdownPath, relocateMarkdownLinks } from "./markdown-links.js";

export function renderAgentContext(root: string, local = false): string {
  const scopes = local ? localDecisionScopes(root) : decisionScopes(root, false);
  const width = hasCollectionProject(root)
    ? required(required(readConfig(root).markdown, "markdown configuration").wrap_width, "wrap width")
    : 120;
  return renderScopeContext(root, scopes, width, local);
}

export function renderScopeContext(
  root: string,
  scopes: DecisionScope[],
  width: number,
  local: boolean,
  absoluteLinks = local,
): string {
  const link = (label: string, path: string) => {
    return `[${label}](${markdownPath(absoluteLinks ? path : relative(root, path))})`;
  };
  let output = "";
  for (const scope of scopes) {
    const applies = scope.appliesTo.includes(".")
      ? "Entire repository"
      : scope.appliesTo.map((path) => `\`${path}/\` and descendants`).join(", ");
    output += `\n## ${scope.source ? `${scope.local ? "Local" : "Project-owned"} ${scope.project.id} decisions` : scope.shared ? "Shared Workbench decisions" : scope.project.id}\n\nApplies to: ${applies}.\n\n`;
    output += `Decision map: ${link(scope.project.id, join(scope.recordsDirectory, "decision-map.md"))}.\n`;
    if (!scope.shared) {
      const charterPath = join(scope.directory, "workbench/CHARTER.md");
      output += `\n### Charter\n\n`;
      output += existsSync(charterPath)
        ? `${relocateMarkdownLinks(readText(charterPath), charterPath, join(root, "AGENTS.md"), absoluteLinks).trimEnd()}\n`
        : `Charter not yet provided: \`${relative(root, charterPath).split(sep).join("/")}\`.\n`;
    }
    if (scope.decisions.some((decision) => !!decision.instruction)) output += "\n### Agent instructions\n";
    for (const decision of scope.decisions) {
      if (!decision.instruction) continue;
      output += `\n- ${wrap(`${link(decision.reference, decision.path)}: ${relocateMarkdownLinks(decision.instruction, decision.path, join(root, "AGENTS.md"), absoluteLinks)}`, width, 2)}\n`;
    }
  }
  // Keep discovery portable: installed policies and machine-specific paths stay out of shared context.
  if (!local) {
    output += `\n## Local collections\n\n${wrap("Before acting, run `workbench collection context` to load local instructions, then `workbench collection compatibility check`. Without Workbench, read the agent's configured local collection entry points and `workbench/.local-collections/AGENTS.md` when present.", width)}\n`;
  }
  if (local && !scopes.length) output += "\nNo local collections are installed for this checkout.\n";
  return `${output.trim()}\n`;
}

export function syncAgents(root: string, checkOnly = false): string[] {
  const path = join(root, "AGENTS.md");
  let expected = renderAgentContext(root);
  const start = "<!-- workbench:context:start -->";
  const end = "<!-- workbench:context:end -->";
  const managed = `${start}\n${expected}${end}`;
  let actual: string | undefined;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error(`${path}: must be a regular file`);
    actual = readText(path);
  }
  if (actual) {
    const first = actual.indexOf(start),
      last = actual.indexOf(end);
    if (
      first < 0 !== last < 0 ||
      (first >= 0 &&
        (last < first || actual.includes(start, first + start.length) || actual.includes(end, last + end.length)))
    )
      throw new Error(
        `${path}: invalid Workbench context markers; preserve existing guidance and repair the marked section`,
      );
    expected =
      first < 0
        ? `${actual}${actual.endsWith("\n") ? "\n" : "\n\n"}${managed}\n`
        : actual.slice(0, first) + managed + actual.slice(last + end.length);
  } else expected = `${managed}\n`;
  if (actual === expected) return [];
  if (checkOnly) throw new Error(`${path}: generated context is missing or stale; run 'workbench sync'`);
  writeAtomic(path, expected);
  return [path];
}
