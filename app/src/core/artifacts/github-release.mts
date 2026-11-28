import { acquireCommand, acquisitionAttempt } from "../toolchains/acquisition/network-command.mts";
import {
  AcquisitionReason,
  acquisitionReason,
  retryNetwork,
  settleNetworkCleanup,
  AcquisitionRejected,
} from "../toolchains/acquisition/network-retry.mts";
import { captureOwnedChild } from "../runtime/owned-child.mjs";
import { processFailure } from "../runtime/process-outcome.mjs";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { record, required, string } from "../runtime/values.mjs";
export interface PublishedRelease {
  target_commitish: string;
  body: string;
  draft: boolean;
  published_at?: string;
  assets: { name: string }[];
}
function readPublishedRelease(value: unknown): PublishedRelease {
  const data = record(value, "Invalid release");
  if (typeof data.draft !== "boolean" || !Array.isArray(data.assets)) throw new Error("Invalid release state");
  return {
    target_commitish: string(data.target_commitish, "Missing release source"),
    body: string(data.body, "Missing release identity"),
    draft: data.draft,
    ...(typeof data.published_at === "string" ? { published_at: data.published_at } : {}),
    assets: data.assets.map((asset: unknown) => ({
      name: string(record(asset, "Invalid release asset").name, "Missing release asset name"),
    })),
  };
}

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
  async verifyTag(tag: string, revision: string, requireExisting = false): Promise<void> {
    const value = await this.optional(`/git/ref/tags/${encodeURIComponent(tag)}`);
    if (value === undefined) {
      if (requireExisting) throw new Error("Push the reviewed release tag before publishing its assets");
      return;
    }
    let target = record(record(value, "Invalid tag").object, "Invalid tag target");
    for (let depth = 0; target.type === "tag" && depth < 8; depth++) {
      const oid = string(target.sha, "Invalid annotated tag");
      if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("Invalid remote annotated tag identity");
      const annotated = record(await this.api(`/git/tags/${oid}`), "Invalid annotated tag");
      target = record(annotated.object, "Invalid annotated tag target");
    }
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
  async download(tag: string, directory: string, names: readonly string[]): Promise<void> {
    await this.downloadFiles(directory, [
      "release",
      "download",
      tag,
      "--repo",
      this.repository,
      ...names.flatMap((name) => ["--pattern", name]),
    ]);
  }
  async publish(tag: string): Promise<void> {
    await this.command("release", "edit", tag, "--repo", this.repository, "--draft=false");
  }
  assetURL(tag: string, name: string): string {
    return `https://github.com/${this.repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
  }
}

/** A retry reconciles a matching draft and validates every remote file before making it public. */
export async function publishGitHubFiles(
  github: Pick<GitHubRelease, "release" | "verifyTag" | "create" | "upload" | "download" | "publish">,
  tag: string,
  revision: string,
  marker: string,
  files: readonly string[],
  scratch: string,
  requireTag = false,
): Promise<void> {
  const names = files.map((path) => basename(path));
  if (!names.length || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)))
    throw new Error("Select release files with portable asset names");
  const unique = new Set(names);
  if (unique.size !== names.length) throw new Error("Release asset names must be unique");
  const sha256 = async (path: string) => {
    if (!lstatSync(path).isFile()) throw new Error(`${path}: expected a regular release asset`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  };
  const expected = await Promise.all(
    files.map(async (path) => ({ path, name: basename(path), sha256: await sha256(path) })),
  );
  const existing = await github.release(tag);
  await github.verifyTag(tag, revision, requireTag);
  if (
    existing &&
    ((!requireTag && existing.target_commitish !== revision) ||
      existing.body !== marker ||
      existing.assets.some(({ name }) => !unique.has(name)))
  )
    throw new Error("Existing release differs from the selected immutable publication");
  if (!existing) await github.create(tag, revision, marker);
  for (const entry of expected) {
    if (existing?.assets.some((asset) => asset.name === entry.name)) continue;
    if (existing && !existing.draft) throw new Error("Published release is missing required assets; refusing mutation");
    await github.upload(tag, entry.path);
  }
  const verify = async (destination: string) => {
    await github.download(tag, destination, names);
    for (const entry of expected)
      if ((await sha256(join(destination, entry.name))) !== entry.sha256)
        throw new Error(`Published ${entry.name} differs from the tested artifact; preserving release for inspection`);
  };
  if (!existing || existing.draft) {
    await verify(join(scratch, "draft-verification"));
    await github.publish(tag);
  }
  await verify(join(scratch, "published-verification"));
}
