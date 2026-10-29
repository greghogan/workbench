import { toolAdapter } from "./tool-adapters.js";
import { type Tool, assetFor, toolDirectory } from "./native-assets.js";
import type { ToolAsset } from "./tool-downloads.js";

type ManagedInstallation = { tool: Tool; asset?: undefined; destination?: undefined } & (
  { provider: "rustup" } | { provider: "uv" } | { provider: "visual-studio" } | { provider: "unavailable" }
);
export type NativeInstallation =
  | ManagedInstallation
  | {
      provider: "artifact";
      tool: Tool;
      asset: ToolAsset;
      destination: string;
    };

/** Absence of a downloadable artifact never implies a runtime manager. */
export function resolveNativeTool(distribution: string, directory: string, tool: Tool): NativeInstallation {
  const installer = toolAdapter(tool).installer;
  if (installer !== "artifact") return { provider: installer, tool };
  const asset = assetFor(distribution, tool, directory);
  return asset
    ? { provider: "artifact", tool, asset, destination: toolDirectory(tool, asset) }
    : { provider: "unavailable", tool };
}
