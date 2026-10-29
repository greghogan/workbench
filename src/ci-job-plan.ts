import { ciTargets, type CITarget } from "./ci-targets.js";
import { readConfig } from "./project-configuration.js";
import { configuredCIJobs, assertOperationCoverage, type CIJob } from "../scripts/ci-operations.mjs";
import { ciPlatform, type ImageBuilder } from "./ci-hosting.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";

export interface CIJobGroup {
  id: string;
  os: string;
  architecture: string;
  environment: string;
  profile?: string;
  targets: CITarget[];
  jobs: CIJob[];
}
/** Both hosts serialize this graph; each configured phase has exactly one operation owner. */
export function ciJobGroups(root: string, targets?: CITarget[]): CIJobGroup[] {
  return withConfigurationSnapshot(() => {
    const selected = targets ?? ciTargets(root),
      config = readConfig(root);
    const groups = new Map<string, CIJobGroup>();
    for (const target of selected) {
      ciPlatform(target.os, target.architecture);
      const id = `${target.os}-${target.architecture}-${target.environment}`;
      let group = groups.get(id);
      if (!group) {
        const builder = target.environment === "nix-docker" ? "nix" : target.environment;
        const profile = target.os === "linux" ? config.ci?.images?.[builder as ImageBuilder] : undefined;
        if (["nix", "guix"].includes(builder) && !profile)
          throw new Error(`${builder} CI requires ci.images configuration`);
        group = {
          id,
          os: target.os,
          architecture: target.architecture,
          environment: target.environment,
          ...(profile ? { profile } : {}),
          targets: [],
          jobs: [],
        };
        groups.set(id, group);
      }
      group.targets.push(target);
    }
    for (const group of groups.values()) group.jobs = configuredCIJobs(group.targets);
    assertOperationCoverage(
      selected,
      [...groups.values()].flatMap((group) => group.jobs),
    );
    return [...groups.values()];
  });
}
