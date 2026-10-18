import { type Command, Option } from "commander";
import { join, resolve } from "node:path";
import { readConfig } from "./core.js";
import { ensureLocalIgnore } from "./environments.js";
import { systemCollectionDirectories } from "./collections.js";
import { userDirectory } from "./storage.js";
import { approveLocalPolicy, cancelLocalRemoval, prepareLocalRemoval, reviewLocalPolicy } from "./local-policy.js";
import {
  acknowledgePolicyCompatibility,
  checkPolicyCompatibility,
  policyCompatibility,
} from "./policy-compatibility.js";
import { syncLocalContext } from "./local-context.js";
import { withStagedPolicyReview } from "./review-policy.js";

interface LocalOptions {
  scope: string;
  directory?: string;
}
function location(root: string, options: LocalOptions): string {
  if (options.directory) {
    if (options.scope === "local") throw new Error("--directory applies only to user or system collections");
    return resolve(options.directory);
  }
  if (options.scope === "local") {
    readConfig(root);
    return join(root, "workbench/.local-collections");
  }
  if (options.scope === "user") return join(userDirectory("data"), "collections");
  const system = systemCollectionDirectories()[0];
  if (!system) throw new Error("no system collection directory; supply --directory");
  return system;
}
function scope(command: Command): Command {
  return command
    .addOption(
      new Option("--scope <scope>", "Local installation to review")
        .choices(["user", "system", "local"])
        .default("user"),
    )
    .option("--directory <path>", "Explicit user or system collection directory");
}
export function registerLocalPolicyCommands(collection: Command, root: string): void {
  const local = collection.command("local").description("Review and activate editable local policies");
  scope(
    local.command("review").argument("<id>").description("Show exact draft changes and their activation digest"),
  ).action((id: string, options: LocalOptions) => {
    console.log(JSON.stringify(reviewLocalPolicy(location(root, options), id), null, 2));
  });
  scope(
    local
      .command("approve")
      .argument("<id>")
      .description("Activate an exact local policy after human approval")
      .requiredOption("--digest <sha256>", "Digest from local review")
      .option("--human-approved", "Attest that a human approved these exact changes"),
  ).action((id: string, options: LocalOptions & { digest: string; humanApproved?: boolean }) => {
    approveLocalPolicy(location(root, options), id, options.digest, !!options.humanApproved);
    console.log("Activated the human-approved local selection and rebuilt local context.");
  });
  scope(
    local
      .command("remove")
      .argument("<id>")
      .description("Prepare a removal for human review; active policy remains unchanged"),
  ).action((id: string, options: LocalOptions) => {
    prepareLocalRemoval(location(root, options), id);
    console.log("Removal prepared; inspect collection local review, then approve its digest.");
  });
  scope(
    local.command("retain").argument("<id>").description("Cancel a pending removal while preserving draft edits"),
  ).action((id: string, options: LocalOptions) => {
    cancelLocalRemoval(location(root, options), id);
  });
  scope(
    local
      .command("sync")
      .description("Rebuild local AGENTS.md, including an empty context when no collections are active"),
  ).action((options: LocalOptions) => {
    if (options.scope === "local") ensureLocalIgnore(root);
    console.log(syncLocalContext(location(root, options)));
  });

  const compatibility = collection
    .command("compatibility")
    .description("Inspect local/project policy compatibility review")
    .option("--staged", "Inspect proposed project policy from the Git index")
    .action(async (_options: { staged?: boolean }, command: Command) => {
      if (!command.optsWithGlobals().staged) {
        console.log(JSON.stringify(policyCompatibility(root), null, 2));
        return;
      }
      await withStagedPolicyReview(root, (review) => {
        console.log(JSON.stringify(review.status, null, 2));
      });
    });
  compatibility
    .command("check")
    .description("Reject stale reviews, missing context, and namespace collisions")
    .option("--staged", "Check compatibility of proposed project policy from the Git index")
    .action(async (_options: { staged?: boolean }, command: Command) => {
      if (command.optsWithGlobals().staged)
        await withStagedPolicyReview(root, (review) => {
          review.check();
        });
      else checkPolicyCompatibility(root);
      console.log("Local/project compatibility review is current or unnecessary.");
    });
  compatibility
    .command("acknowledge")
    .description("Record a performed compatibility review; semantic conflicts require human resolution")
    .requiredOption("--digest <sha256>", "Exact combined digest from compatibility inspection")
    .option("--reviewed", "Attest that both policy sets were read and are compatible")
    .option("--staged", "Acknowledge proposed project policy from the Git index")
    .action(async (options: { digest: string; reviewed?: boolean; staged?: boolean }, command: Command) => {
      if (command.optsWithGlobals().staged)
        await withStagedPolicyReview(root, (review) => {
          review.acknowledge(options.digest, !!options.reviewed);
        });
      else acknowledgePolicyCompatibility(root, options.digest, !!options.reviewed);
      console.log("Recorded compatibility review for this checkout and these exact policies.");
    });
}
