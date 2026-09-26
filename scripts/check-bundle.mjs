import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const name of ["main", "skills"]) {
  const expected = readFileSync(join(root, `bundle/${name}.cjs`));
  const result = await build({
    entryPoints: [join(root, `ts/${name}.ts`)],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(root, `bundle/${name}.cjs`),
    write: false,
    logLevel: "silent",
  });
  if (!result.outputFiles[0] || Buffer.compare(Buffer.from(result.outputFiles[0].contents), expected) !== 0) {
    throw new Error(`bundle/${name}.cjs is stale; run pnpm run build`);
  }
}
console.log("Committed bundles match TypeScript source and locked build tools.");
