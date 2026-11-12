import { createRequire } from "node:module";

const runtime = createRequire(import.meta.url)(
  "../bundle/package.cjs",
) as typeof import("../app/src/core/artifacts/package-output.js");
export const { packageOutput } = runtime;
