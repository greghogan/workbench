import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCandidate } from "./ci-candidate.mts";
import { required } from "./values.mjs";
const repository = required(process.env.GITHUB_REPOSITORY, "Missing repository");
const revision = required(process.env.GITHUB_SHA, "Missing revision");
const candidate = readCandidate(
  required(process.env.WORKBENCH_CI_CANDIDATE, "Missing candidate"),
  repository,
  revision,
);
writeFileSync(
  join(required(process.env.RUNNER_TEMP, "Missing runner directory"), "release-ready.json"),
  JSON.stringify({
    ...candidate,
    run: required(process.env.GITHUB_RUN_ID, "Missing run"),
    attempt: required(process.env.GITHUB_RUN_ATTEMPT, "Missing attempt"),
    artifact: required(process.env.CANDIDATE_ARTIFACT, "Missing candidate artifact"),
  }) + "\n",
);
