import { isMainScript } from "./script-entry.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { record, string, required } from "../app/src/core/runtime/values.mjs";
import { bundleCacheFile, reuseBundles } from "./bundle-cache.mts";

export interface CICandidate {
  version: 1;
  repository: string;
  revision: string;
  release: string;
  sha256: string;
  bundleBuildSha256?: string;
}

/** Bind the portable archive to the exact source revision before transferring or executing it. */
export function readCandidate(directory: string, repository: string, revision: string): CICandidate {
  const value = record(JSON.parse(readFileSync(join(directory, "candidate.json"), "utf8")), "Invalid CI candidate");
  const release = string(value.release, "Missing candidate release");
  const sha256 = createHash("sha256")
    .update(readFileSync(join(directory, "workbench-artifacts/workbench.tar.gz")))
    .digest("hex");
  if (
    value.version !== 1 ||
    value.repository !== repository ||
    value.revision !== revision ||
    !/^[0-9a-f]{40}$/.test(revision) ||
    !/^\d+\.\d+\.\d+$/.test(release) ||
    value.sha256 !== sha256 ||
    readFileSync(join(directory, "workbench-artifacts/SHA256SUMS"), "utf8") !== `${sha256}  workbench.tar.gz\n`
  )
    throw new Error("CI candidate source identity or archive digest does not match");
  const bundleBuildSha256 = value.bundleBuildSha256;
  if (
    bundleBuildSha256 !== undefined &&
    (typeof bundleBuildSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(bundleBuildSha256) ||
      createHash("sha256")
        .update(readFileSync(join(directory, "bundle-build.json")))
        .digest("hex") !== bundleBuildSha256)
  )
    throw new Error("CI candidate bundle metadata digest does not match");
  return {
    version: 1,
    repository,
    revision,
    release,
    sha256,
    ...(bundleBuildSha256 === undefined ? {} : { bundleBuildSha256 }),
  };
}

export function candidateRevision(root = process.cwd()): string {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
  if (dirty.length) throw new Error("Candidate must be built from a clean selected revision");
  return revision;
}

export function recordCandidate(directory: string, environment = process.env): CICandidate {
  const repository = required(environment.GITHUB_REPOSITORY, "Missing candidate repository");
  const revision = required(environment.GITHUB_SHA, "Missing candidate revision");
  if (candidateRevision() !== revision) throw new Error("Candidate must be built from a clean selected revision");
  const metadata = record(JSON.parse(readFileSync("package.json", "utf8")), "Invalid package metadata");
  let bundleBuildSha256: string | undefined;
  if (existsSync(bundleCacheFile)) {
    if (!reuseBundles(process.cwd())) throw new Error("Candidate bundles must match the selected source");
    const bytes = readFileSync(bundleCacheFile);
    const cache = record(JSON.parse(bytes.toString()), "Invalid bundle cache");
    for (const path of Object.keys(record(cache.outputs, "Missing bundle outputs"))) {
      mkdirSync(join(directory, "bundle"), { recursive: true });
      cpSync(path, join(directory, path));
    }
    writeFileSync(join(directory, "bundle-build.json"), bytes);
    bundleBuildSha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const value = {
    version: 1,
    repository,
    revision,
    release: string(metadata.version, "Missing package version"),
    sha256: createHash("sha256")
      .update(readFileSync(join(directory, "workbench-artifacts/workbench.tar.gz")))
      .digest("hex"),
    ...(bundleBuildSha256 === undefined ? {} : { bundleBuildSha256 }),
  };
  writeFileSync(join(directory, "candidate.json"), JSON.stringify(value) + "\n", { flag: "wx" });
  return readCandidate(directory, repository, revision);
}

export function activateCandidate(directory: string, environment = process.env, root = process.cwd()): void {
  const candidate = readCandidate(
    directory,
    required(environment.GITHUB_REPOSITORY, "Missing repository"),
    required(environment.GITHUB_SHA, "Missing revision"),
  );
  if (!candidate.bundleBuildSha256 || !reuseBundles(directory, root, "bundle-build.json"))
    throw new Error("CI candidate bundles do not match this checkout or are incomplete");
}

if (isMainScript(import.meta.url)) {
  const directory = required(process.argv[3], "Missing candidate directory");
  if (process.argv[2] === "record") recordCandidate(directory);
  else if (process.argv[2] === "activate") activateCandidate(directory);
  else if (process.argv[2] === "verify")
    readCandidate(
      directory,
      required(process.env.GITHUB_REPOSITORY, "Missing repository"),
      required(process.env.GITHUB_SHA, "Missing revision"),
    );
  else throw new Error("Select candidate record, activate, or verify");
}
