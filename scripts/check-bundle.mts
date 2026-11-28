import { buildTooling, collectToolingArtifacts } from "./build-tooling.mts";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBundles, verifyBundles } from "./bundle-build.mjs";
import { verifyRuntimeDependencies } from "./runtime-dependencies.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
let started = performance.now();
const timing = (phase: string) => {
  const now = performance.now();
  console.log(`Bundle ${phase}: ${((now - started) / 1000).toFixed(2)}s`);
  started = now;
};
await buildTooling({ root, operation: "verify" });
timing("tooling verification");
const bundles = await compileBundles(root);
timing("compilation and license inventory");
verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
verifyBundles(root, bundles);
timing("runtime and output verification");
console.log("Generated bundles pass runtime and license verification.");
execFileSync(process.execPath, [join(root, "bin/workbench.mjs"), "native-assets-prune", "--check"], {
  cwd: root,
  stdio: "inherit",
});
