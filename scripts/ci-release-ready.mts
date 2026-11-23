import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCandidate } from "./ci-candidate.mts";
import { required } from "../app/src/core/runtime/values.mjs";
import { checkedWorkbenchZip, checkedWorkbenchZipArtifact, workbenchZipTargets } from "./release-contract.mts";
const repository = required(process.env.GITHUB_REPOSITORY, "Missing repository");
const revision = required(process.env.GITHUB_SHA, "Missing revision");
const temporary = required(process.env.RUNNER_TEMP, "Missing runner directory");
const artifact = required(process.env.CANDIDATE_ARTIFACT, "Missing candidate artifact");
const candidate = readCandidate(
  required(process.env.WORKBENCH_CI_CANDIDATE, "Missing candidate"),
  repository,
  revision,
);
const zips = Object.fromEntries(
  workbenchZipTargets.map((target) => {
    const path = join(temporary, "release-packages", checkedWorkbenchZipArtifact(target, artifact));
    return [target, checkedWorkbenchZip(path, target, revision).sha256];
  }),
);
writeFileSync(
  join(temporary, "release-ready.json"),
  JSON.stringify({
    ...candidate,
    version: 2,
    run: required(process.env.GITHUB_RUN_ID, "Missing run"),
    attempt: required(process.env.GITHUB_RUN_ATTEMPT, "Missing attempt"),
    artifact,
    zips,
  }) + "\n",
);
