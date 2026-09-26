import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const name of ["main", "skills"]) {
  await build({
    entryPoints: [join(root, `ts/${name}.ts`)],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(root, `bundle/${name}.cjs`),
    logLevel: "silent",
  });
}
