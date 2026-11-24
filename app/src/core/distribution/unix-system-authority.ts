import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { launchdSystemDirectory } from "./distribution-identity.js";

export function systemRuntimeDirectory(): string {
  return process.platform === "darwin"
    ? launchdSystemDirectory
    : (process.env.WORKBENCH_SYSTEM_RUNTIME_DIRECTORY ?? "/run/workbench");
}

export function verifySystemPath(path: string): void {
  if (!isAbsolute(path)) throw new Error("System service paths must be absolute");
  const current = lstatSync(path);
  if (current.isSymbolicLink() || current.uid !== 0 || current.mode & 0o022)
    throw new Error(`${path}: system service requires administrator-owned, protected paths`);
  if (dirname(path) !== path) verifySystemPath(dirname(path));
}
