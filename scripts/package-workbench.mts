import { createRequire } from "node:module";

const runtime = createRequire(import.meta.url)("../bundle/package.cjs") as typeof import("../src/package.js");
await runtime.prepareWorkbenchPackage();
