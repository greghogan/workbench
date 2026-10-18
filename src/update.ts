import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { distributionRoot } from "./core.js";
import { parseSkillIdentities, skillCatalog, skillChanges } from "./skill-catalog.js";
import { policyExecutionEnvironment } from "./policy-compatibility.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToolPin, npmWorkbench, toolSpecification } from "./launcher.js";
import { setConfiguration } from "./config-command.js";
import { git, clean, cloneTree, prepareManagedPatch } from "./update-git.js";
import { withCacheLock } from "./cache-lock.js";

/** Executable updates are independent of collection reconciliation and never stage or commit changes. */
export async function updateWorkbench(root: string, revision?: string): Promise<void> {
  const previous = readToolPin(root);
  if (!previous || !revision)
    throw new Error(
      "configure tool.repository and tool.revision, then supply a full commit to workbench update COMMIT",
    );
  const next = { ...previous, revision };
  toolSpecification(next);
  const lock = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "workbench/update"]).trim();
  mkdirSync(join(lock, ".."), { recursive: true });
  await withCacheLock(lock, async () => {
    clean(root);
    const beforeSkills = skillCatalog(distributionRoot(root));
    const original = git(root, ["rev-parse", "HEAD"]).trim();
    const temporary = mkdtempSync(join(tmpdir(), "workbench-update-"));
    try {
      const prepared = join(temporary, "project");
      cloneTree(root, prepared, original);
      setConfiguration(prepared, "tool.revision", revision, "project");
      const saved = process.env.WORKBENCH_PROJECT_ROOT;
      const priorPreparation = process.env.WORKBENCH_UPDATE_PREPARATION;
      const priorReview = process.env.WORKBENCH_POLICY_REVIEW;
      const review = policyExecutionEnvironment(root).WORKBENCH_POLICY_REVIEW;
      if (review !== undefined) process.env.WORKBENCH_POLICY_REVIEW = review;
      process.env.WORKBENCH_UPDATE_PREPARATION = prepared;
      process.env.WORKBENCH_PROJECT_ROOT = prepared;
      try {
        await npmWorkbench(toolSpecification(next), ["update-prepare"], prepared);
      } finally {
        if (priorPreparation === undefined) Reflect.deleteProperty(process.env, "WORKBENCH_UPDATE_PREPARATION");
        else process.env.WORKBENCH_UPDATE_PREPARATION = priorPreparation;
        if (saved === undefined) Reflect.deleteProperty(process.env, "WORKBENCH_PROJECT_ROOT");
        else process.env.WORKBENCH_PROJECT_ROOT = saved;
        if (priorReview === undefined) Reflect.deleteProperty(process.env, "WORKBENCH_POLICY_REVIEW");
        else process.env.WORKBENCH_POLICY_REVIEW = priorReview;
      }
      if (process.exitCode) throw new Error("target executable preparation failed; checkout unchanged");
      const afterSkills = parseSkillIdentities(
        JSON.parse(readFileSync(join(prepared, "workbench/.skill-catalog.json"), "utf8")),
        "prepared skill catalog",
      );
      const { patch } = prepareManagedPatch(root, prepared, original, temporary);
      clean(root);
      if (git(root, ["rev-parse", "HEAD"]).trim() !== original) throw new Error("checkout changed during preparation");
      if (patch) {
        git(root, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
        git(root, ["apply", "--whitespace=nowarn", "-"], patch);
      }
      console.log(
        `Prepared executable update ${previous.revision} -> ${revision}. Collections were not updated. Review before committing; nothing was staged.`,
      );
      for (const [kind, names] of Object.entries(skillChanges(beforeSkills, afterSkills)))
        if (names.length) console.log(`Skills ${kind}: ${names.join(", ")}.`);
      // The target executable resolves its own installation path before rebuilding local discovery.
      await npmWorkbench(toolSpecification(next), ["sync"], root);
      if (process.exitCode)
        throw new Error("executable update applied; local synchronization failed; run workbench sync");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
