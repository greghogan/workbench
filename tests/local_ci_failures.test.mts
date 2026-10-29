import { test } from "vitest";
import { localCIFixture } from "./fixtures/local-ci-execution.mjs";

const { verifyFailure } = localCIFixture();

test
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each([
    "build-failure",
    "wrong-architecture",
    "container-failure",
    "target-failure",
    "managed-failure",
    "cleanup-failure",
  ])("local %s preserves independent outcomes and records the failure", verifyFailure);
