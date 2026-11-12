import { join } from "node:path";
import { ensureLocalIgnore } from "../execution/environments/environments.js";
import { readConfig } from "../projects/project-configuration.js";
import { distributionRoot } from "../projects/project-context.js";
import { formatFiles } from "../records/formatting.js";
import { synchronize } from "../records/sync.js";
import { validate } from "../records/validation.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { skillCatalog, skillIdentities } from "../skills/skill-catalog.js";
import { validateAgentReviewState } from "../review/agent-review.js";
import { validateDocumentReviewState } from "../review/review-service.js";
import { readTaskQueue } from "../tasks/task-queue.js";
import { readTaskDecisions } from "../tasks/task-decisions.js";

/** The isolated checkout supplies proposed project inputs; the real checkout supplies local state. */
export function preflightUpdateState(root: string): void {
  try {
    validateAgentReviewState(root);
    readTaskQueue(root);
    readTaskDecisions(root);
    validateDocumentReviewState(root);
  } catch (cause) {
    throw new Error(
      "The target release cannot read this checkout's local review or task state. " +
        "The executable pin is unchanged. Preserve the reported state file and resolve it before retrying the update; " +
        "do not discard human approvals or reinterpret old agent attestations.",
      { cause },
    );
  }
}

/** Run only in the updater's isolated checkout, using the target revision. */
export async function prepareUpdate(root: string): Promise<void> {
  readConfig(root);
  const stateRoot = process.env.WORKBENCH_LOCAL_CONFIG_ROOT;
  if (!stateRoot) throw new Error("Update preparation requires the original checkout for local-state validation");
  preflightUpdateState(stateRoot);
  ensureLocalIgnore(root);
  await formatFiles(root, undefined, { all: true, write: true });
  synchronize(root, false);
  writeAtomic(
    join(root, "workbench/.skill-catalog.json"),
    JSON.stringify(skillIdentities(skillCatalog(distributionRoot(root)))),
  );
  await validate(root);
  console.log("Update preparation validated.");
}
