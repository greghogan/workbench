import { test } from "vitest";
import { localCIFixture } from "./fixtures/local-ci-execution.mjs";

const { verifyFailure } = localCIFixture();

test
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  // Schema variants are covered at parseRunReport's boundary. Exercise missing, partial, and rejected
  // reports through the full coordinator to prove independent work and cleanup still complete.
  .each(["no-results", "incomplete-results", "duplicate-target"])(
  "local %s preserves independent outcomes and records the failure",
  verifyFailure,
);
