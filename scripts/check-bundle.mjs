import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleLicenses, noticesPath } from "./bundle-licenses.mjs";
import { bundleOptions } from "./bundle-options.mjs";
import { bundleArtifacts, bundleCompression, bundleFormats } from "./bundle-artifacts.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inputs = new Set();
const compression = bundleCompression(root);
for (const name of ["main", "skills"]) {
  const result = await build({
    ...bundleOptions(root, name),
    write: false,
  });
  if (!result.outputFiles[0]) throw new Error(`No bundle output for ${name}`);
  for (const [path, bytes] of bundleArtifacts(name, result.outputFiles[0].contents, compression))
    if (!existsSync(join(root, "bundle", path)) || !readFileSync(join(root, "bundle", path)).equals(bytes))
      throw new Error(`bundle/${path} is stale; run pnpm run build`);
  for (const extension of Object.values(bundleFormats))
    if (extension !== bundleFormats[compression] && existsSync(join(root, "bundle", `${name}.cjs.${extension}`)))
      throw new Error(`bundle/${name}.cjs.${extension} is obsolete; run pnpm run build`);
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
}
if (readFileSync(join(root, noticesPath), "utf8") !== bundleLicenses(root, inputs))
  throw new Error(`${noticesPath} is stale; run pnpm run build`);
console.log("Committed bundles match TypeScript source and locked build tools.");
