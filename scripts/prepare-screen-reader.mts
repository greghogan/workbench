import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { withManagedProcesses } from "./managed-process.mjs";
import { toolDirectory } from "../src/native-assets.ts";
import { installAsset, type ToolAsset } from "../src/tool-downloads.ts";
import { standaloneTools } from "../src/toolchains.ts";
import { required } from "./values.mjs";

/** The headed browser shares the existing browser version authority; the upstream manifest pins NVDA's archive. */
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Screen-reader setup currently supports Windows x64 with NVDA");
  const root = resolve(import.meta.dirname, "..");
  const version = required(standaloneTools(root).get("chromium-headless-shell"), "Missing browser version pin");
  const tool = { name: "chromium-headed", version, source: ".tool-versions (shared browser pin)" };
  const asset = required(
    (JSON.parse(readFileSync(join(root, "scripts/screen-reader-assets.json"), "utf8")) as Record<string, ToolAsset>)[
      version
    ],
    "Prepare the pinned headed Chrome for Testing Windows recipe before updating the browser",
  );
  const directory = toolDirectory(tool, asset);
  await installAsset(directory, asset);
  const require = createRequire(import.meta.url);
  const installer = join(require.resolve("@guidepup/setup/package.json"), "../bin/guidepup");
  await withManagedProcesses(async (scope) => {
    await scope.run(process.execPath, [installer, "setup", "--ci"]);
    await scope.run(process.execPath, [installer, "install"]);
  });
  const browser = join(directory, asset.bin, asset.executable ?? "chrome.exe");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `browser=${browser}\n`);
  console.log(`Verified headed browser: ${browser}`);
}
await main();
