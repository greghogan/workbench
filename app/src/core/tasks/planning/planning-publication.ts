import { WeightedCache } from "../../storage/weighted-cache.js";
import { resolve } from "node:path";
import { gitBytes, readGitObjects, readGitTree } from "../../git/git-snapshot.js";
import { pushUpdates, zeroRevision } from "../../git/push-updates.js";
import { InvalidInput } from "../../runtime/input-errors.js";
import { record, string } from "../../runtime/values.mjs";
import { indexPlanningRevision } from "./planning-index.js";
import { planningSettings } from "./planning-store.js";
import { parsePlan, planningPaths } from "./plan-model.js";

const verifiedPlans = new WeightedCache<boolean>(32 * 1024 * 1024);

/** Every retained checkpoint is planning-only, not merely the final tree. */
export function verifyPlanningHistory(root: string, tip: string): void {
  for (const revision of gitBytes(root, ["rev-list", tip]).toString().trim().split("\n").filter(Boolean)) {
    const plans = new Map(
        [...indexPlanningRevision(root, revision)].filter(
          ([reference, plan]) => !verifiedPlans.get(`${resolve(root)}:${reference}:${plan.tree}`),
        ),
      ),
      requests = [
        ...new Set(
          [...plans.values()].flatMap((plan) =>
            [planningPaths.document, planningPaths.approval, planningPaths.approved + planningPaths.document].flatMap(
              (path) => plan.entries.get(path)?.oid ?? [],
            ),
          ),
        ),
      ],
      objects = readGitObjects(root, requests, 2 * 1024 * 1024, { retainedBytes: 32 * 1024 * 1024 });
    for (const [reference, plan] of plans) {
      const document = objects.get(plan.entries.get(planningPaths.document)?.oid ?? "");
      if (!document) throw new InvalidInput(`Missing plan contents: ${reference}`);
      parsePlan(document.toString(), reference);
      const approved = plan.entries.get(planningPaths.approved + planningPaths.document),
        approval = plan.entries.get(planningPaths.approval),
        hasApproved = [...plan.entries.keys()].some((path) => path.startsWith(planningPaths.approved));
      if (hasApproved || approval) {
        if (!approved || !approval) throw new InvalidInput(`Incomplete plan approval: ${reference}`);
        const contents = objects.get(approved.oid),
          metadata = objects.get(approval.oid);
        if (!contents || !metadata || parsePlan(contents.toString(), reference).metadata.status !== "Approved")
          throw new InvalidInput(`Invalid approved plan: ${reference}`);
        const data = record(JSON.parse(metadata.toString()) as unknown, "Invalid plan approval"),
          at = string(data.at, "Missing approval time");
        if (Object.keys(data).some((key) => key !== "at") || !Number.isFinite(Date.parse(at)))
          throw new InvalidInput(`Invalid plan approval time: ${reference}`);
      }
      const key = `${resolve(root)}:${reference}:${plan.tree}`;
      verifiedPlans.set(key, true, key.length * 2 + 128);
    }
  }
}
export function includesPlanningHistory(root: string, tip: string): boolean {
  return gitBytes(root, ["rev-list", "--max-parents=0", tip])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((revision) => readGitTree(root, revision).has(planningPaths.scopes));
}
/** Exempt only the configured logical remote, endpoint and destination. No save ever pushes. */
export function checkPlanningPublication(root: string, input: string, remote: string, endpoint: string): string[] {
  const settings = planningSettings(root),
    updates = pushUpdates(input),
    exempt: string[] = [];
  let destination = false;
  if (settings.remote === remote && settings.remote_branch) {
    const endpoints = gitBytes(root, ["remote", "get-url", "--push", "--all", remote]).toString().trim().split("\n");
    destination = endpoints.includes(endpoint);
  }
  for (const update of updates) {
    if (destination && update.remoteRef === `refs/heads/${settings.remote_branch ?? ""}`) {
      if (!zeroRevision(update.tip)) verifyPlanningHistory(root, update.tip);
      exempt.push(update.localRef);
    } else if (
      !zeroRevision(update.tip) &&
      gitBytes(root, ["cat-file", "-t", `${update.tip}^{}`])
        .toString()
        .trim() === "commit" &&
      includesPlanningHistory(root, update.tip)
    )
      throw new InvalidInput(
        "Planning history may be pushed only to its configured planning destination; implementation publication remains separately reviewed",
      );
  }
  return exempt;
}
