import { acquireCommand, acquisitionAttempt } from "./network-command.mts";
import {
  AcquisitionReason,
  acquisitionReason,
  retryNetwork,
  settleNetworkCleanup,
  AcquisitionRejected,
} from "./network-retry.mts";
import { captureOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { record, required } from "./values.mjs";
import { readPublishedRelease } from "./release-contract.mts";

/** All authenticated GitHub effects stay behind one narrowly scoped transport. */
export class GitHubRelease {
  readonly repository: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly signal: AbortSignal;
  constructor(repository: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    this.repository = repository;
    this.env = env;
    this.signal = signal;
  }
  /** Mutations run once and drain before cancellation returns, so a retry must first reconcile server state. */
  private async command(...args: string[]): Promise<void> {
    this.signal.throwIfAborted();
    const result = await captureOwnedChild(
      "gh",
      args,
      {
        cwd: process.cwd(),
        env: this.env,
        signal: this.signal,
        shutdown: "drain",
      },
      16 * 1024 * 1024,
    );
    const failure = processFailure("GitHub release mutation", result, result);
    if (failure) throw failure;
    this.signal.throwIfAborted();
  }
  private query(...args: string[]): Promise<string> {
    return acquireCommand("Read GitHub release metadata", "gh", args, {
      env: this.env,
      capture: true,
      signal: this.signal,
    });
  }
  async api(path: string): Promise<unknown> {
    return JSON.parse(await this.query("api", `/repos/${this.repository}${path}`)) as unknown;
  }
  private async optional(path: string): Promise<unknown> {
    try {
      return await this.api(path);
    } catch (error) {
      if (acquisitionReason(error) === AcquisitionReason.Missing) return undefined;
      throw error;
    }
  }
  /** Each download attempt is private; only a complete directory becomes visible to verification. */
  private async downloadFiles(directory: string, args: string[]): Promise<void> {
    if (existsSync(directory)) throw new Error("Release acquisition requires a new destination directory");
    mkdirSync(dirname(directory), { recursive: true });
    const signal = this.signal;
    await retryNetwork(
      "Download verified release inputs",
      async () => {
        const staging = mkdtempSync(join(dirname(directory), ".release-acquisition-"));
        let failure: unknown;
        try {
          const incoming = join(staging, "incoming");
          await acquisitionAttempt("Download verified release inputs", "gh", [...args, "--dir", incoming], {
            env: this.env,
            signal: signal,
            quiet: true,
          });
          signal.throwIfAborted();
          try {
            renameSync(incoming, directory);
          } catch (cause) {
            throw new AcquisitionRejected("Could not publish complete release inputs locally", { cause });
          }
        } catch (error) {
          failure = error;
        }
        await settleNetworkCleanup(
          [
            () => {
              rmSync(staging, { recursive: true, force: true });
            },
          ],
          failure,
        );
      },
      { signal: signal },
    );
  }
  async release(tag: string) {
    const [owner, name] = this.repository.split("/");
    // Pending draft tags are queryable through GraphQL; REST's tag endpoint covers published releases only.
    const query =
      "query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId}}}";
    const response: unknown = JSON.parse(
      await this.query(
        "api",
        "graphql",
        "--raw-field",
        `query=${query}`,
        "--raw-field",
        `owner=${required(owner, "Missing release owner")}`,
        "--raw-field",
        `name=${required(name, "Missing release repository")}`,
        "--raw-field",
        `tag=${tag}`,
      ),
    );
    const repository = record(
      record(record(response, "Invalid release lookup").data, "Invalid release data").repository,
      "Missing release repository",
    );
    if (repository.release === null) return undefined;
    const id = record(repository.release, "Invalid release identity").databaseId;
    if (!Number.isSafeInteger(id) || Number(id) < 1) throw new Error("Invalid release database identity");
    return readPublishedRelease(await this.api(`/releases/${String(id)}`));
  }
  async verifyTag(tag: string, revision: string): Promise<void> {
    const value = await this.optional(`/git/ref/tags/${encodeURIComponent(tag)}`);
    if (value === undefined) return;
    const target = record(record(value, "Invalid tag").object, "Invalid tag target");
    if (target.type !== "commit" || target.sha !== revision)
      throw new Error("Release tag already identifies different source");
  }
  async downloadRun(id: string, artifact: string, directory: string): Promise<void> {
    await this.downloadFiles(directory, ["run", "download", id, "--repo", this.repository, "--name", artifact]);
  }
  async create(tag: string, revision: string, marker: string): Promise<void> {
    await this.command(
      "release",
      "create",
      tag,
      "--repo",
      this.repository,
      "--draft",
      "--target",
      revision,
      "--title",
      `Workbench ${tag}`,
      "--notes",
      marker,
    );
  }
  async upload(tag: string, path: string): Promise<void> {
    await this.command("release", "upload", tag, path, "--repo", this.repository);
  }
  async download(tag: string, directory: string): Promise<void> {
    await this.downloadFiles(directory, [
      "release",
      "download",
      tag,
      "--repo",
      this.repository,
      "--pattern",
      "workbench.tar.gz",
      "--pattern",
      "SHA256SUMS",
    ]);
  }
  async publish(tag: string): Promise<void> {
    await this.command("release", "edit", tag, "--repo", this.repository, "--draft=false");
  }
}
