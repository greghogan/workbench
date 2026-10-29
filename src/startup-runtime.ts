import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assetFor, toolDirectory } from "./native-assets.js";
import { installAsset } from "./tool-downloads.js";
import { exactVersion } from "./toolchains.js";
import { withToolCacheUseAsync } from "./tool-cache-lock.js";
import { toolRequirement } from "./tool-requirements.js";
import { launchProcess, ownsStartupRuntime } from "./launcher.js";

/** Restart before command planning, fingerprints, or worker creation can use the bootstrap Node. */
export async function restartWithStartupRuntime(distribution: string): Promise<boolean> {
  if (!ownsStartupRuntime()) return false;
  const pin = join(distribution, ".node-version");
  const tool = { name: "node", version: exactVersion(readFileSync(pin, "utf8").trim(), pin), source: pin };
  const asset = assetFor(distribution, tool);
  if (!asset) throw new Error(`no verified Workbench startup Node ${tool.version} artifact`);
  const name = process.platform === "win32" ? "node.exe" : "node";
  const current = realpathSync(process.execPath);
  const installation = resolve(dirname(current), asset.bin === "." ? "." : "..");
  const receipt = join(installation, ".workbench-artifact");
  // A verified running SDK remains usable with isolated cache preferences (including test sandboxes).
  if (
    process.versions.node === tool.version &&
    current === join(installation, asset.bin, name) &&
    existsSync(receipt) &&
    readFileSync(receipt, "utf8").trim() === asset.sha256
  )
    return false;
  const directory = toolDirectory(tool, asset);
  const executable = join(directory, asset.bin, name);
  if (current === resolve(executable)) throw new Error(`${directory}: invalid Workbench startup Node installation`);
  const entry = process.argv[1];
  if (!entry) throw new Error("Workbench startup requires an executable entry point");
  await withToolCacheUseAsync(async () => {
    await installAsset(directory, asset);
    await launchProcess(executable, [...process.execArgv, resolve(entry), ...process.argv.slice(2)]);
  }, [toolRequirement(tool, directory)]);
  return true;
}
