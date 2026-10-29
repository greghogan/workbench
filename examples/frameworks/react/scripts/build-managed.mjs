// Generated from build-managed.mts; edit the TypeScript source.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("build", { recursive: true });
const child = spawnSync(
  "esbuild",
  [
    "src/main.tsx",
    "--bundle",
    "--minify",
    "--platform=browser",
    "--format=iife",
    "--jsx=automatic",
    "--target=es2022",
    "--outfile=build/app.js",
    '--define:process.env.NODE_ENV="production"',
    "--legal-comments=eof",
  ],
  { stdio: "inherit" },
);
if (child.error || child.status !== 0) throw new Error(`esbuild failed: ${String(child.error ?? child.status)}`);
cpSync("index.html", "build/index.html");
