import { test } from "vitest";
import { localCIFixture } from "./fixtures/local-ci-execution.mjs";

const { verifyFailure } = localCIFixture();

test
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each([
    "no-results",
    "missing-target",
    "incomplete-results",
    "duplicate-target",
    "unknown-target",
    "invalid-error",
    "invalid-results",
  ])("local %s preserves independent outcomes and records the failure", verifyFailure);
