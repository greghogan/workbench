import { build } from "esbuild";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output =
  process.env.WORKBENCH_STORAGE_EXTERNAL !== "false" && process.env.WORKBENCH_BUILD_DIR
    ? join(process.env.WORKBENCH_BUILD_DIR, "react", "build")
    : resolve("build");
if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error("build output must be a real directory");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const types = spawnSync(process.execPath, ["node_modules/@typescript/native/bin/tsc", "--noEmit"], {
  stdio: "inherit",
});
if (types.error || types.status !== 0) throw new Error(`Type checking failed: ${types.error ?? types.status}`);
await build({
  entryPoints: ["src/main.tsx"],
  outfile: join(output, "app.js"),
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: false,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});
cpSync("index.html", join(output, "index.html"));
if (process.argv[2] === "release") {
  const destination = resolve("dist/site");
  if (existsSync("dist") && lstatSync("dist").isSymbolicLink()) throw new Error("dist must be a real directory");
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink())
    throw new Error("release output must be a real directory");
  rmSync(destination, { recursive: true, force: true });
  cpSync(output, destination, { recursive: true });
}
console.log(`Built React application at ${output}`);
