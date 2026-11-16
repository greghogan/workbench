import { join } from "node:path";
import { gitReferenceInputs } from "../../git/refs.js";
import { repositoryStatePath } from "../../git/repository-state.js";
import { planningSettings } from "./planning-settings.js";
import { planningPaths } from "./plan-model.js";
export function planningInputs(root: string): string[] {
  const state = repositoryStatePath(root),
    branch = planningSettings(root).branch;
  return [
    join(state, planningPaths.settings),
    join(state, planningPaths.operation),
    ...gitReferenceInputs(root, [
      planningPaths.groups,
      planningPaths.drafts,
      planningPaths.bases,
      planningPaths.removals,
      planningPaths.operations,
      ...(branch ? [`refs/heads/${branch}`] : []),
    ]),
  ];
}
