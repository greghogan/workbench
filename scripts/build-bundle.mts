import { record } from "./values.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { execFileSync } from "node:child_process";
import { compileBundles, publishBundles } from "./bundle-build.mjs";
import { collectToolingArtifacts } from "./build-tooling.mts";
import { verifyRuntimeDependencies } from "./runtime-dependencies.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundles = await compileBundles(root);
verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
publishBundles(root, bundles);
const maintenance = [join(root, "bin/workbench.mjs"), "native-assets-prune"];
const plan = record(
  JSON.parse(
    execFileSync(process.execPath, [...maintenance, "--plan"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ),
  "Invalid asset pruning plan",
);
const contents = await format(JSON.stringify(plan.inventory), { parser: "json", printWidth: 120 });
execFileSync(process.execPath, [...maintenance, "--apply"], {
  cwd: root,
  input: JSON.stringify({ original: plan.original, contents }),
  stdio: ["pipe", "inherit", "inherit"],
});
