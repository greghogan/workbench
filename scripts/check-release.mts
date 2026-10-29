import { createRequire } from "node:module";

const runtime = createRequire(import.meta.url)("../bundle/package.cjs") as typeof import("../src/package-verify.js");
await runtime.verifyWorkbenchPackage(process.argv[2] ?? process.env.WORKBENCH_CI_CANDIDATE, process.argv[3]);
