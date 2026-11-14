import { join, dirname } from "node:path";
import { gitBytes } from "../../git/git-snapshot.js";
import { repositoryStatePath } from "../../git/repository-state.js";
import { planningSettings } from "./planning-store.js";
import { planningPaths } from "./plan-model.js";

/** Observe loose-ref creation and replacement as well as packed references, without pinning a planning revision. */
export function planningInputs(root: string): string[] {
  const state = repositoryStatePath(root),
    common = dirname(state),
    paths = new Set([
      join(state, planningPaths.settings),
      join(state, planningPaths.operation),
      join(common, "packed-refs"),
      join(common, planningPaths.groups),
    ]);
  const branch = planningSettings(root).branch,
    prefixes = [
      planningPaths.drafts,
      planningPaths.bases,
      planningPaths.removals,
      planningPaths.operations,
      ...(branch ? [`refs/heads/${branch}`] : []),
    ];
  const refs = gitBytes(root, ["for-each-ref", "--format=%(refname)", ...prefixes])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const ref of [...prefixes, ...refs]) {
    for (let path = join(common, ref); path !== common; path = dirname(path)) paths.add(path);
  }
  return [...paths];
}
