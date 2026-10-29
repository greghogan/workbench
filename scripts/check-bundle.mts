import { buildTooling, collectToolingArtifacts } from "./build-tooling.mts";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBundles, publishBundles, verifyBundles } from "./bundle-build.mjs";
import { verifyRuntimeDependencies } from "./runtime-dependencies.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await buildTooling({ root, operation: "verify" });
const bundles = await compileBundles(root);
verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
publishBundles(root, bundles);
verifyBundles(root, bundles);
console.log("Generated bundles pass runtime and license verification.");
execFileSync(process.execPath, [join(root, "bin/workbench.mjs"), "native-assets-prune", "--check"], {
  cwd: root,
  stdio: "inherit",
});
