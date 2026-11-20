import { createRequire } from "node:module";
import { compileBundles, publishBundles } from "./bundle-build.mjs";
import { collectToolingArtifacts } from "./build-tooling.mts";
import { launchdNativeHelper } from "../app/src/core/distribution/launchd-paths.mts";
import { launchdHelperBytes } from "./launchd-helper.mts";
import { verifyRuntimeDependencies } from "./runtime-dependencies.mjs";
import { windowsNativeHelper, windowsServiceHelperBytes } from "./windows-service-helper.mts";

const root = process.cwd();
const bundles = await compileBundles(root);
verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
publishBundles(root, bundles);
const runtime = createRequire(import.meta.url)(
  "../bundle/package.cjs",
) as typeof import("../app/src/core/artifacts/package.js");
const generated: { path: string; contents: Uint8Array; executable?: true }[] = [...bundles.outputs];
const launchd = launchdHelperBytes(root);
if (launchd) generated.push({ path: launchdNativeHelper, contents: launchd, executable: true });
const windows = windowsServiceHelperBytes(root);
if (windows) generated.push({ path: windowsNativeHelper, contents: windows });
await runtime.prepareWorkbenchPackage(root, { generated });
