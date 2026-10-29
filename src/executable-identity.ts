import { realpathSync } from "node:fs";
import { executingToolPin } from "./launcher.js";
import { toolPin } from "./tool-pin.js";

export interface ExecutableIdentity {
  version: 1;
  repository: string | null;
  revision: string | null;
  directory: string;
  node: { executable: string; version: string };
}
export function executableIdentity(distribution: string): ExecutableIdentity {
  const pin = executingToolPin(distribution);
  return {
    version: 1,
    repository: pin?.repository ?? null,
    revision: pin?.revision ?? null,
    directory: realpathSync(distribution),
    node: { executable: process.execPath, version: process.versions.node },
  };
}

export function readExecutableIdentity(value: unknown): ExecutableIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid executable identity");
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    typeof input.directory !== "string" ||
    !input.directory ||
    !input.node ||
    typeof input.node !== "object" ||
    Array.isArray(input.node)
  )
    throw new Error("Invalid executable identity");
  const node = input.node as Record<string, unknown>;
  if (typeof node.executable !== "string" || !node.executable || typeof node.version !== "string" || !node.version)
    throw new Error("Invalid executable runtime");
  const pin =
    input.repository === null && input.revision === null
      ? undefined
      : toolPin({ repository: input.repository, revision: input.revision });
  return {
    version: 1,
    repository: pin?.repository ?? null,
    revision: pin?.revision ?? null,
    directory: input.directory,
    node: { executable: node.executable, version: node.version },
  };
}
