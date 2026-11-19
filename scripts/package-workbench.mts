import { createRequire } from "node:module";
import { compileBundles, publishBundles } from "./bundle-build.mjs";
import { collectToolingArtifacts } from "./build-tooling.mts";
import { launchdNativeHelper } from "../app/src/core/distribution/launchd-paths.mts";
import { launchdHelperBytes } from "./launchd-helper.mts";
import { verifyRuntimeDependencies } from "./runtime-dependencies.mjs";

const root = process.cwd();
const bundles = await compileBundles(root);
verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
publishBundles(root, bundles);
const runtime = createRequire(import.meta.url)(
  "../bundle/package.cjs",
) as typeof import("../app/src/core/artifacts/package.js");
const launchd = launchdHelperBytes(root);
await runtime.prepareWorkbenchPackage(root, {
  generated: launchd
    ? [...bundles.outputs, { path: launchdNativeHelper, contents: launchd, executable: true }]
    : bundles.outputs,
});
