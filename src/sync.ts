import { syncCitationIgnores } from "./projects.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { distributionRoot, readConfig } from "./core.js";
import { syncMaps } from "./maps.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncReleaseIndexes } from "./releases.js";
import { syncAgents } from "./agents.js";
import { syncSkills } from "./skills.js";
import { syncTaskChecklists } from "./task-checklists.js";
import { syncCollectionLinks } from "./collection-links.js";
import { ensureLocalIgnore } from "./environments.js";

export function synchronize(root: string): number {
  readConfig(root);
  ensureLocalIgnore(root);
  syncCitationIgnores(root);
  const paths = [
    ...syncCollectionLinks(root),
    ...syncRecordSequences(root),
    ...syncTaskChecklists(root),
    ...syncMaps(root),
    ...syncReleaseIndexes(root),
  ];
  if (existsSync(join(root, "workbench/CHARTER.md"))) paths.push(...syncAgents(root));
  paths.push(...syncSkills(root, distributionRoot(root)));
  for (const path of paths) console.log(`Updated ${path}.`);
  return paths.length;
}
