import { record, string } from "./values.mjs";
import type { CICandidate } from "./ci-candidate.mts";

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
    proof.version !== 1 ||
    proof.run !== id ||
    proof.attempt !== selected.attempt ||
    proof.revision !== selected.revision ||
    proof.repository !== repository ||
    !new RegExp(`^workbench-candidate-${id}-[1-9][0-9]*$`).test(artifact)
  )
    throw new Error("Release proof belongs to another run or revision");
  return {
    artifact,
    sha256: string(proof.sha256, "Missing candidate digest"),
    release: string(proof.release, "Missing release version"),
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
export interface PublishedRelease {
  target_commitish: string;
  body: string;
  draft: boolean;
  assets: { name: string }[];
}
export function readPublishedRelease(value: unknown): PublishedRelease {
  const data = record(value, "Invalid release");
  if (typeof data.draft !== "boolean" || !Array.isArray(data.assets)) throw new Error("Invalid release state");
  return {
    target_commitish: string(data.target_commitish, "Missing release source"),
    body: string(data.body, "Missing release identity"),
    draft: data.draft,
    assets: data.assets.map((asset: unknown) => ({
      name: string(record(asset, "Invalid release asset").name, "Missing release asset name"),
    })),
  };
}
