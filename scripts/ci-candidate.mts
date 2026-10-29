import { isMainScript } from "./script-entry.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { record, string, required } from "./values.mjs";

export interface CICandidate {
  version: 1;
  repository: string;
  revision: string;
  release: string;
  sha256: string;
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
  return { version: 1, repository, revision, release, sha256 };
}

export function recordCandidate(directory: string, environment = process.env): CICandidate {
  const repository = required(environment.GITHUB_REPOSITORY, "Missing candidate repository");
  const revision = required(environment.GITHUB_SHA, "Missing candidate revision");
  const current = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (current !== revision || dirty.length) throw new Error("Candidate must be built from a clean selected revision");
  const metadata = record(JSON.parse(readFileSync("package.json", "utf8")), "Invalid package metadata");
  const value = {
    version: 1,
    repository,
    revision,
    release: string(metadata.version, "Missing package version"),
    sha256: createHash("sha256")
      .update(readFileSync(join(directory, "workbench-artifacts/workbench.tar.gz")))
      .digest("hex"),
  };
  writeFileSync(join(directory, "candidate.json"), JSON.stringify(value) + "\n", { flag: "wx" });
  return readCandidate(directory, repository, revision);
}

if (isMainScript(import.meta.url)) {
  const directory = required(process.argv[3], "Missing candidate directory");
  if (process.argv[2] === "record") recordCandidate(directory);
  else if (process.argv[2] === "verify")
    readCandidate(
      directory,
      required(process.env.GITHUB_REPOSITORY, "Missing repository"),
      required(process.env.GITHUB_SHA, "Missing revision"),
    );
  else throw new Error("Select candidate record or verify");
}
