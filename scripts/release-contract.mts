import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { record, records, string } from "../app/src/core/runtime/values.mjs";
import type { CICandidate } from "./ci-candidate.mts";

export const workbenchZipTargets = ["macos-arm64", "windows-x64"] as const;
type ZipTarget = (typeof workbenchZipTargets)[number];

export function checkedWorkbenchZipArtifact(target: ZipTarget, candidate: string): string {
  return `release-packages-workbench-app.${target}.native-${candidate}`;
}

function readReleaseFile(path: string, maximum: number): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > maximum) throw new Error(`${path}: invalid release evidence file`);
  return readFileSync(path);
}

/** Reauthenticate the exact package bytes retained by the selected native Checks job. */
export function checkedWorkbenchZip(directory: string, target: ZipTarget, revision: string) {
  const readMetadata = (path: string): unknown => JSON.parse(readReleaseFile(path, 256 * 1024).toString("utf8"));
  const report = record(readMetadata(join(directory, "packages.json")), "Invalid release package report");
  const entries = records(report.packages, "Missing release package outcomes");
  const [entry] = entries;
  if (
    report.version !== 1 ||
    report.revision !== revision ||
    report.tag !== undefined ||
    entries.length !== 1 ||
    entry?.id !== `native.${target}.archive.workbench-release` ||
    entry.status !== "verified"
  )
    throw new Error(`${target}: missing matching native release package evidence`);
  const expected = string(entry.manifestSha256, "Missing release package manifest digest");
  if (!/^[a-f0-9]{64}$/.test(expected) || entry.directory !== `artifact-${expected}`)
    throw new Error(`${target}: invalid release package manifest digest`);
  const exported = join(directory, entry.directory);
  if (!lstatSync(exported).isDirectory()) throw new Error(`${target}: invalid release package directory`);
  const contents = readReleaseFile(join(exported, "workbench-artifact.json"), 256 * 1024);
  if (createHash("sha256").update(contents).digest("hex") !== expected)
    throw new Error(`${target}: release package manifest differs from native verification`);
  const manifest = record(JSON.parse(contents.toString("utf8")), "Invalid release package manifest");
  const evidence = record(manifest.verification, "Missing release package verification");
  const file = readReleaseFile(join(exported, "artifact.zip"), 512 * 1024 * 1024);
  const sha256 = createHash("sha256").update(file).digest("hex");
  if (
    manifest.version !== 1 ||
    manifest.file !== "artifact.zip" ||
    manifest.releaseTag !== undefined ||
    manifest.revision !== revision ||
    manifest.recipe !== entry.recipe ||
    evidence.platform !== target ||
    evidence.revision !== revision ||
    evidence.source !== undefined ||
    evidence.sha256 !== sha256 ||
    manifest.sha256 !== sha256 ||
    entry.sha256 !== sha256 ||
    manifest.bytes !== file.length
  )
    throw new Error(`${target}: release package differs from the verified bytes or source`);
  return { file, sha256 };
}

/** Only promote bytes from successful complete main CI. Never execute or rebuild downloaded code. */
export function successfulReleaseRun(value: unknown, repository: string, id: string) {
  const run = record(value, "Invalid Checks run");
  if (
    String(run.id) !== id ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== "main" ||
    !["push", "workflow_dispatch"].includes(string(run.event, "Missing event")) ||
    run.path !== ".github/workflows/checks.yml" ||
    record(run.repository, "Missing repository").full_name !== repository ||
    record(run.head_repository, "Missing source repository").full_name !== repository ||
    !/^[0-9a-f]{40}$/.test(string(run.head_sha, "Missing revision")) ||
    !Number.isSafeInteger(run.run_attempt) ||
    Number(run.run_attempt) < 1
  )
    throw new Error("Publication requires successful complete Checks from this repository's main branch");
  return { revision: string(run.head_sha, "Missing revision"), attempt: String(run.run_attempt) };
}

export function readReleaseProof(
  value: unknown,
  repository: string,
  id: string,
  selected: { revision: string; attempt: string },
) {
  const proof = record(value, "Invalid release evidence");
  const artifact = string(proof.artifact, "Missing candidate artifact");
  if (
    proof.version !== 2 ||
    proof.run !== id ||
    proof.attempt !== selected.attempt ||
    proof.revision !== selected.revision ||
    proof.repository !== repository ||
    !new RegExp(`^workbench-candidate-${id}-[1-9][0-9]*$`).test(artifact)
  )
    throw new Error("Release proof belongs to another run or revision");
  const zips = record(proof.zips, "Missing verified Workbench ZIP digests");
  const zipDigests = new Map(
    workbenchZipTargets.map((target) => {
      const digest = string(zips[target], `Missing ${target} package digest`);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid ${target} package digest`);
      return [target, digest] as const;
    }),
  );
  return {
    artifact,
    sha256: string(proof.sha256, "Missing candidate digest"),
    release: string(proof.release, "Missing release version"),
    zipDigests,
  };
}
export function verifyReleaseCandidate(
  proof: { sha256: string; release: string },
  candidate: CICandidate,
  source: unknown,
): void {
  if (proof.sha256 !== candidate.sha256 || proof.release !== candidate.release)
    throw new Error("Candidate differs from the tested release proof");
  if (record(source, "Invalid source metadata").version !== candidate.release)
    throw new Error("Release version differs from tested source");
}
