import { projectPaths } from "../projects/project-paths.js";
import { syncCitationStorage } from "../projects/projects.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { distributionRoot } from "../projects/project-context.js";
import { readConfig } from "../projects/project-configuration.js";
import { syncMaps } from "./maps.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncReleaseIndexes } from "./releases.js";
import { syncAgents } from "./agents.js";
import { syncSkills } from "../skills/skills.js";
import { syncTaskChecklists } from "../tasks/task-checklists.js";
import { ensureLocalIgnore } from "../execution/environments/environments.js";

export function synchronize(root: string, localSkills = true, report: (message: string) => void = console.log): number {
  readConfig(root);
  ensureLocalIgnore(root);
  syncCitationStorage(root);
  const paths = [
    ...syncRecordSequences(root),
    ...syncTaskChecklists(root),
    ...syncMaps(root),
    ...syncReleaseIndexes(root),
  ];
  if (existsSync(join(root, projectPaths.charter))) paths.push(...syncAgents(root));
  if (localSkills) paths.push(...syncSkills(root, distributionRoot(root)));
  for (const path of paths) report(`Updated ${path}.`);
  return paths.length;
}
