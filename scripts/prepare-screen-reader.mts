import { acquireCommand } from "./network-command.mts";
import { runCIEntry } from "./ci-errors.mts";
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
  const platform =
    process.platform === "darwin" && process.arch === "arm64"
      ? "mac-arm64"
      : process.platform === "win32" && process.arch === "x64"
        ? "win64"
        : undefined;
  if (!platform) throw new Error("Screen-reader setup requires Windows x64 or macOS ARM64");
  const root = resolve(import.meta.dirname, "..");
  const version = required(standaloneTools(root).get("chromium-headless-shell"), "Missing browser version pin");
  const tool = { name: "chromium-headed", version, source: ".tool-versions (shared browser pin)" };
  const asset = required(
    (
      JSON.parse(readFileSync(join(root, "scripts/screen-reader-assets.json"), "utf8")) as Record<
        string,
        Record<string, ToolAsset>
      >
    )[version]?.[platform],
    "Prepare the pinned headed Chrome for Testing platform recipe before updating the browser",
  );
  const directory = toolDirectory(tool, asset);
  await installAsset(directory, asset);
  if (platform === "mac-arm64") {
    await withManagedProcesses(async (scope) => {
      // This pinned CfT archive has ad-hoc signatures, not a Google Developer ID signature.
      // installAsset verifies the archive digest; the recipe records unavailable publisher authentication.
      await scope.run("xattr", ["-dr", "com.apple.quarantine", directory]);
    });
  }
  const require = createRequire(import.meta.url);
  const installer = join(require.resolve("@guidepup/setup/package.json"), "../bin/guidepup");
  await withManagedProcesses(async (scope) => {
    await scope.run(process.execPath, [installer, "setup", "--ci"]);
    await acquireCommand("Acquire the selected screen-reader runtime", process.execPath, [installer, "install"]);
    if (platform === "mac-arm64") await scope.run("defaults", ["write", "-g", "AppleKeyboardUIMode", "-int", "2"]);
  });
  const browser = join(directory, asset.bin, asset.executable ?? "chrome.exe");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `browser=${browser}\n`);
  console.log(`Verified headed browser: ${browser}`);
}
await runCIEntry("Prepare screen-reader tools", main);
