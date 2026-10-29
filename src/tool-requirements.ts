import { isAbsolute } from "node:path";

export interface ToolRequirement {
  tool: string;
  version: string;
  directory?: string;
}

/** Miri uses a Rust-managed toolchain rather than a separate installation. */
export function toolRequirement(tool: { name: string; version: string }, directory?: string): ToolRequirement {
  return {
    tool: tool.name === "miri" ? "rust" : tool.name,
    version: tool.version,
    ...(directory === undefined ? {} : { directory }),
  };
}

/** Active leases and retained results use the same tool identity contract. */
export function isToolRequirement(value: unknown): value is ToolRequirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  return (
    "tool" in value &&
    text(value.tool) &&
    "version" in value &&
    text(value.version) &&
    (!("directory" in value) || value.directory === undefined || (text(value.directory) && isAbsolute(value.directory)))
  );
}

/** Workbench owns exact destinations; runtime managers own versioned toolsets. */
export function matchesToolRequirement(
  requirement: ToolRequirement,
  installation: { provider: string; directory: string; tool: string; version: string },
): boolean {
  return installation.provider === "workbench"
    ? requirement.directory === installation.directory
    : requirement.tool === installation.tool && requirement.version === installation.version;
}
