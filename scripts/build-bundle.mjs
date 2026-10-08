import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { bundleLicenses, noticesPath } from "./bundle-licenses.mjs";
import { bundleOptions } from "./bundle-options.mjs";
import { bundleArtifacts, bundleCompression, bundleFormats } from "./bundle-artifacts.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inputs = new Set();
const compression = bundleCompression(root);
const artifacts = new Map();
for (const name of ["main", "skills"]) {
  const result = await build({ ...bundleOptions(root, name), write: false });
  for (const [path, bytes] of bundleArtifacts(name, result.outputFiles[0].contents, compression))
    artifacts.set(path, bytes);
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
}
const notices = bundleLicenses(root, inputs);
for (const [path, bytes] of artifacts) writeFileSync(join(root, "bundle", path), bytes);
for (const name of ["main", "skills"])
  for (const extension of Object.values(bundleFormats))
    if (extension !== bundleFormats[compression])
      rmSync(join(root, "bundle", `${name}.cjs.${extension}`), { force: true });
writeFileSync(join(root, noticesPath), notices);
