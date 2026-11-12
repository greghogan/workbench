import { createRequire } from "node:module";
import { compileBundles, publishBundles } from "./bundle-build.mjs";
import { collectToolingArtifacts } from "./build-tooling.mts";
import { verifyRuntimeDependencies } from "./runtime-dependencies.mjs";

const root = process.cwd();
const bundles = await compileBundles(root);
verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
publishBundles(root, bundles);
const runtime = createRequire(import.meta.url)(
  "../bundle/package.cjs",
) as typeof import("../app/src/core/artifacts/package.js");
await runtime.prepareWorkbenchPackage(root, { generated: bundles.outputs });
