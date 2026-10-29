import { createHash } from "node:crypto";
import { workingReviewTree } from "./git-snapshot.js";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ciJobGroups, type CIJobGroup } from "./ci-job-plan.js";
import { ciDestination } from "./ci-destinations.js";
import { distributionRoot } from "./project-context.js";
import { acquireCIImage, restoreCIImage } from "./ci-images.js";
import { executeHostedCISelection } from "./ci-hosted-target.js";
import { CILifecycle, executeCI } from "../scripts/ci-lifecycle.mjs";
import { targetEnvironment } from "../scripts/ci-contract.mjs";

import { writeAtomic } from "../scripts/file-publication.mjs";
import { record } from "../scripts/values.mjs";
import { readText } from "./files.js";

function groupFor(root: string, id: string): CIJobGroup {
  const group = ciJobGroups(root).find((group) => group.id === id);
  if (!group) throw new Error(`Unknown CI preparation group: ${id}`);
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  if (group.os !== os || group.architecture !== process.arch)
    throw new Error("CI jobs require their declared native OS and architecture");
  return group;
}
function fingerprint(root: string, group: CIJobGroup, remote: string): string {
  const tree = workingReviewTree(root);
  return createHash("sha256")
    .update(JSON.stringify([tree, group, ciDestination(root, remote)]))
    .digest("hex");
}

/** Preparation never runs project tests; immutable image metadata or verified cache inputs feed operation jobs. */
export async function prepareHostedCI(root: string, id: string, remote: string, output: string): Promise<void> {
  const group = groupFor(root, id),
    destination = ciDestination(root, remote),
    identity = fingerprint(root, group, remote);
  const lifecycle = new CILifecycle();
  const directory = resolve(root, output);
  try {
    mkdirSync(directory, { recursive: true });
    rmSync(join(directory, "prepared.json"), { force: true });
    let image;
    if (group.profile) {
      image = await acquireCIImage(root, group.profile, destination);
    } else {
      for (const target of group.targets) {
        if (target.kind !== "native") continue;
        await lifecycle.checkpoint();
        await executeCI(process.execPath, [join(distributionRoot(root), "scripts/ci-run.mjs"), "native-install"], {
          cwd: root,
          env: { ...process.env, ...targetEnvironment(target), RUNNER_TEMP: directory },
        });
      }
    }
    await lifecycle.checkpoint();
    if (fingerprint(root, groupFor(root, id), remote) !== identity)
      throw new Error("CI preparation inputs changed during execution");
    writeAtomic(
      join(directory, "prepared.json"),
      JSON.stringify({ version: 1, group: id, identity, ...(image ? { image } : {}) }) + "\n",
    );
  } finally {
    lifecycle.close();
  }
}

export async function runHostedCIJob(
  root: string,
  groupID: string,
  jobID: string,
  remote: string,
  prepared: string,
  reports: string,
): Promise<void> {
  const group = groupFor(root, groupID),
    destination = ciDestination(root, remote);
  const job = group.jobs.find((job) => job.artifact === jobID);
  if (!job) throw new Error(`Unknown configured CI operation: ${jobID}`);
  const receipt = record(JSON.parse(readText(resolve(root, prepared))), "Invalid CI preparation receipt");
  if (receipt.version !== 1 || receipt.group !== groupID || receipt.identity !== fingerprint(root, group, remote))
    throw new Error("CI preparation receipt belongs to different source, configuration, or destination");
  if (!group.profile && receipt.image !== undefined)
    throw new Error("Native CI preparation unexpectedly contains an image");
  await executeHostedCISelection(root, job.targets, reports, {
    operation: job.operation,
    ...(group.profile
      ? { profile: group.profile, image: await restoreCIImage(root, group.profile, receipt.image, destination) }
      : {}),
  });
}
