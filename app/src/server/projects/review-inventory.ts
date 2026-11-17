import { allCommitReviews, reviewRecordCount } from "../../core/review/review-units.js";
import { taskReviewInventory } from "./task-review-inventory.js";
import { reviewTaskOwner, reviewTaskPaths } from "../review/task-review-groups.js";
import { projectPaths } from "../../core/projects/project-paths.js";
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { withConfigurationSnapshot } from "../../core/configuration/configuration-snapshot.js";
import { localCollectionDirectories, resolveLocalCollections } from "../../core/collections/collections.js";
import {
  policyCompatibility,
  policyCompatibilityReceipt,
  compatibilityFindingsPath,
} from "../../core/collections/policy-compatibility.js";
import { GitSnapshot } from "../../core/git/git-snapshot.js";
import { readConfig, readProjects } from "../../core/projects/project-configuration.js";
import { observeGitInputs } from "../../core/projects/workspace-inputs.js";
import { protectedRecordPaths, recordOwnerPath } from "../../core/records/staged-records.js";
import { ReviewFormatter } from "../../core/review/review-formatting.js";
import { pendingRecordOutputs, reviewPreparationPath } from "../../core/review/review-preparation-state.js";
import { reviewStatus, reviewGit, ReviewSource } from "../../core/review/review-service.js";
import { reviewFileLimit } from "../../core/review/review-snapshot.js";
import { inputStamp } from "../../core/runtime/file-identity.js";
import { readBoundedFile } from "../../core/runtime/file-reads.js";
import { retainedBytes } from "../../core/runtime/retained-bytes.js";
import { userConfigPath } from "../../core/configuration/user-config.js";
import { needsReview, PreparationState, type ReviewPreparation } from "../review/review-state.js";
import { reviewOwner } from "../review/review-membership.js";

export interface ReviewInventoryResult {
  count: number;
  inputs: Map<string, string>;
}
/** Observational caches never participate in commit gates or acknowledgment validation. */
export class ReviewInventory {
  private readonly hashes = new Map<string, { stamp: string; algorithm: string; hash: string }>();
  private readonly formatter = new ReviewFormatter();
  private readonly preparation = new Map<string, { stamp: string; width: number; required: boolean }>();
  private git: { snapshot: GitSnapshot; inputs: Map<string, string> } | undefined;
  private previous: { value: ReviewInventoryResult; at: number } | undefined;
  constructor(private readonly root: string) {}

  collect(): Promise<ReviewInventoryResult> {
    const previous = this.previous;
    if (
      previous &&
      Date.now() - previous.at < 60_000 &&
      [...previous.value.inputs].every(([path, stamp]) => inputStamp(path) === stamp)
    )
      return Promise.resolve(previous.value);
    return withConfigurationSnapshot(async () => {
      const value = await this.acquire();
      if (retainedBytes([value.inputs, this.hashes, this.preparation], 16 * 1024 * 1024) <= 16 * 1024 * 1024)
        this.previous = { value, at: Date.now() };
      else {
        this.previous = undefined;
        this.hashes.clear();
        this.preparation.clear();
      }
      return value;
    });
  }
  private async acquire(): Promise<ReviewInventoryResult> {
    const inputs = new Map<string, string>();
    const observe = (path: string) => {
      if (!inputs.has(path)) inputs.set(path, inputStamp(path));
    };
    observe(join(this.root, projectPaths.config));
    observe(join(this.root, projectPaths.projects));
    observe(join(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? this.root, projectPaths.local));
    observe(userConfigPath());
    if (!this.git || ![...this.git.inputs].every(([path, stamp]) => inputStamp(path) === stamp)) {
      const paths = new Map<string, string>();
      observeGitInputs(this.root, (path) => {
        if (!(basename(path) === "review.json" && basename(dirname(path)) === "workbench"))
          paths.set(path, inputStamp(path));
      });
      const headPath = [...paths.keys()].find((path) => basename(path) === "HEAD");
      const ref =
        headPath && existsSync(headPath)
          ? /^ref: (refs\/[^\r\n]+)\r?\n?$/.exec(readBoundedFile(headPath, 8192, "review HEAD").toString())?.[1]
          : undefined;
      if (ref) {
        const path = resolve(this.root, reviewGit(this.root, ["rev-parse", "--git-path", ref]).trim());
        paths.set(path, inputStamp(path));
      }
      this.git = { snapshot: new GitSnapshot(this.root, { staged: false }), inputs: paths };
    }
    for (const [path, stamp] of this.git.inputs) inputs.set(path, stamp);
    const scopes = readProjects(this.root).map((project) => project.path);
    const config = readConfig(this.root);
    const sources = (config.collections?.sources ?? []).map((source) => source.id);
    const seen = new Set<string>();
    const status = reviewStatus(this.root, ReviewSource.Working, this.git.snapshot, (path, algorithm, read) => {
      observe(path);
      seen.add(path);
      const stamp = inputs.get(path) ?? inputStamp(path);
      const saved = this.hashes.get(path);
      if (saved?.stamp === stamp && saved.algorithm === algorithm) return saved.hash;
      const hash = read();
      this.hashes.set(path, { stamp, algorithm, hash });
      return hash;
    });
    for (const path of this.hashes.keys()) if (!seen.has(path)) this.hashes.delete(path);
    observe(status.receipt);
    observe(reviewPreparationPath(this.root));
    const preparation = new Map<string, ReviewPreparation>(
      [...pendingRecordOutputs(this.root)].map((path) => [path, { state: PreparationState.Required }]),
    );
    for (const change of status.changes) {
      observe(join(this.root, change.path));
      if (
        !change.approved ||
        change.after.startsWith("000000:") ||
        recordOwnerPath(change.path, scopes, sources) !== change.path
      )
        continue;
      const width = config.markdown?.wrap_width ?? 120,
        stamp = inputs.get(join(this.root, change.path)) ?? "missing";
      const saved = this.preparation.get(change.path);
      if (saved?.stamp === stamp && saved.width === width) {
        if (saved.required) preparation.set(change.path, { state: PreparationState.Required });
        continue;
      }
      const raw = readBoundedFile(join(this.root, change.path), reviewFileLimit, "review inventory");
      const result = await this.formatter.prepare(change.path, raw, width);
      if (result.state !== "current") preparation.set(change.path, { state: PreparationState.Required });
      if (result.state !== "unavailable")
        this.preparation.set(change.path, { stamp, width, required: result.state !== "current" });
    }
    const changed = new Set(status.changes.map((change) => change.path));
    for (const path of this.preparation.keys()) if (!changed.has(path)) this.preparation.delete(path);
    const pending = new Set<string>();
    for (const change of status.changes)
      if (needsReview(change, preparation))
        pending.add(
          reviewOwner(
            change.path,
            scopes,
            sources,
            (owner) => changed.has(owner) || existsSync(join(this.root, owner)),
          ),
        );
    const policyReceipt = policyCompatibilityReceipt(this.root);
    observe(policyReceipt);
    observe(compatibilityFindingsPath(policyReceipt));
    for (const base of localCollectionDirectories(this.root)) {
      observe(join(base, "index.toml"));
      observe(join(base, "AGENTS.md"));
    }
    for (const collection of resolveLocalCollections(this.root))
      for (const path of collection.files.keys()) observe(join(collection.directory, path));
    let compatibility = false;
    try {
      const report = policyCompatibility(this.root);
      compatibility =
        !!report.sources.length &&
        (!!report.conflicts.length || !!report.assessment?.findings.some((finding) => !finding.decision));
    } catch {
      // A failed compatibility analysis has no actionable human resolution, matching the document queue.
    }
    const tasks = taskReviewInventory(this.root, observe);
    for (const path of protectedRecordPaths(scopes, sources)) observe(join(this.root, path));
    for (const path of [...inputs.keys()]) {
      for (let directory = dirname(path); ; directory = dirname(directory)) {
        observe(directory);
        if (existsSync(directory) && lstatSync(directory).isDirectory()) break;
        if (dirname(directory) === directory) break;
      }
      if (path.startsWith(this.root + sep)) {
        for (let directory = dirname(path); ; directory = dirname(directory)) {
          observe(join(directory, ".gitignore"));
          if (directory === this.root || dirname(directory) === directory) break;
        }
      }
    }
    if (![...inputs].every(([path, stamp]) => inputStamp(path) === stamp))
      throw new Error("Review inputs changed during acquisition; retrying");
    let standalone = 0;
    for (const unit of allCommitReviews(this.root)) {
      if (!unit.pending) continue;
      const owner = reviewTaskOwner(reviewTaskPaths(this.root, unit.revision, unit.parents[0]), tasks.byPath);
      if (!owner)
        standalone += reviewRecordCount(unit.changes.filter((change) => !change.approved).map((change) => change.path));
      else if (owner.metadata.status === "Accepted") tasks.outcomes.add(owner.reference);
    }
    return { count: pending.size + standalone + tasks.outcomes.size + Number(compatibility), inputs };
  }
}
