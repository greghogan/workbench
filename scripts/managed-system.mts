import { writeFileSync } from "node:fs";

export type ManagedSystem = "x86_64-linux" | "aarch64-linux";

export function managedSystem(
  architecture: string = process.env.WORKBENCH_IMAGE_ARCHITECTURE ?? process.arch,
): ManagedSystem {
  if (architecture === "x64") return "x86_64-linux";
  if (architecture === "arm64") return "aarch64-linux";
  throw new Error("Managed image architecture must be x64 or arm64");
}

/** Package definitions may choose binary sources while loading, before the builder consumes --system. */
export function writeGuixSystemFile(destination: string, definition: string, system: ManagedSystem): void {
  writeFileSync(
    destination,
    `(use-modules (guix utils))\n(parameterize ((%current-system "${system}")) (load ${JSON.stringify(definition)}))\n`,
  );
}
