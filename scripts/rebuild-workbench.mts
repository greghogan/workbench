import assert from "node:assert/strict";
import { join } from "node:path";
import { compileBundles, publishBundles } from "./bundle-build.mjs";
import { prepareWorkbenchPackage } from "../src/package.ts";
import { withEngineeringRun } from "./engineering-run.mjs";
import { writeAtomic } from "./file-publication.mjs";

// Runs from the frozen checkout after that checkout has emitted its own authored tooling.
const root = process.cwd();
const bundles = await compileBundles(root);
publishBundles(root, bundles);
const artifact = await prepareWorkbenchPackage(root, { output: join(root, "dist") });
await withEngineeringRun(join(root, "build"), "rebuild-execution", async (job) => {
  assert.match(
    await job.run(process.execPath, [join(root, "bin/workbench.mjs"), "--help"], {
      capture: true,
      env: { ...process.env, WORKBENCH_EPHEMERAL_CHECKOUT: "1", WORKBENCH_PROJECT_ROOT: root },
    }),
    /Usage: workbench/,
  );
});
writeAtomic(
  join(root, "rebuild.json"),
  JSON.stringify({ outputs: bundles.outputs.map((output) => output.path), archive: artifact.archive }) + "\n",
);
