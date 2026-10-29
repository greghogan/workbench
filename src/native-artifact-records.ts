import { join } from "node:path";
import { BoundedState } from "./bounded-state.js";
import { userDirectory } from "./storage.js";
import type { Tool } from "./native-assets.js";
import type { ToolAsset } from "./tool-downloads.js";
import { isRecord } from "../scripts/values.mjs";

function location(tool: Tool): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(tool.name) || !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/.test(tool.version))
    throw new Error("Invalid native tool identity");
  return join(
    userDirectory("state"),
    "native-artifacts",
    tool.name,
    tool.version,
    `${process.platform}-${process.arch}.json`,
  );
}
interface ArtifactRecord {
  version: 1;
  tool: string;
  pin: string;
  platform: string;
  asset: ToolAsset;
}
function store(tool: Tool) {
  return new BoundedState<ArtifactRecord | null>(
    () => location(tool),
    1024 * 1024,
    (input) => {
      if (input === null) return null;
      if (
        !isRecord(input) ||
        input.version !== 1 ||
        input.tool !== tool.name ||
        input.pin !== tool.version ||
        input.platform !== `${process.platform}-${process.arch}` ||
        !isRecord(input.asset)
      )
        throw new Error(`Invalid retained artifact metadata for ${tool.name} ${tool.version}`);
      const asset = input.asset;
      if (
        typeof asset.url !== "string" ||
        !asset.url.startsWith("https://") ||
        typeof asset.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !["tar", "zip", "7z", "binary", "deb"].includes(String(asset.format)) ||
        !Number.isSafeInteger(asset.strip) ||
        Number(asset.strip) < 0 ||
        typeof asset.bin !== "string" ||
        /(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]/.test(asset.bin) ||
        (!asset.signature &&
          !asset.checksums &&
          !asset.attestation &&
          !asset.repository &&
          !asset.authenticationUnavailable)
      )
        throw new Error(`Incomplete retained artifact metadata for ${tool.name} ${tool.version}`);
      return {
        version: 1,
        tool: tool.name,
        pin: tool.version,
        platform: `${process.platform}-${process.arch}`,
        asset: asset as unknown as ToolAsset,
      };
    },
    () => null,
  );
}

/** Installation provenance outlives SDK payload pruning and newer executable catalogs. */
export function retainedNativeArtifact(tool: Tool): ToolAsset | undefined {
  return store(tool).read()?.asset;
}
export function recordNativeArtifact(tool: Tool, asset: ToolAsset): void {
  store(tool).write({
    version: 1,
    tool: tool.name,
    pin: tool.version,
    platform: `${process.platform}-${process.arch}`,
    asset,
  });
}
