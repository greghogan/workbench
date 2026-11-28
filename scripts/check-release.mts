import { createRequire } from "node:module";

const runtime = createRequire(import.meta.url)(
  "../bundle/package.cjs",
) as typeof import("../app/src/core/artifacts/package-verify.js");
const packageDirectory = process.env.WORKBENCH_RELEASE_ARTIFACT;
await runtime.verifyWorkbenchPackage(
  process.argv[2] ?? process.env.WORKBENCH_CI_CANDIDATE,
  process.argv[3],
  undefined,
  {
    ...(packageDirectory === undefined ? {} : { packageDirectory }),
  },
);
