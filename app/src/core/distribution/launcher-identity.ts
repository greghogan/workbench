import { projectPaths } from "../projects/project-paths.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { sameToolPin, specificationPin, toolPin, toolSpecification, type ToolPin } from "../toolchains/tool-pin.js";
import { readDistributionSource } from "./distribution-identity.js";

export function toolProjectRoot(): string | undefined {
  if (process.env.WORKBENCH_PROJECT_ROOT) return resolve(process.env.WORKBENCH_PROJECT_ROOT);
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, projectPaths.config))) return directory;
    if (existsSync(join(directory, ".git"))) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function readToolPin(root: string): ToolPin | undefined {
  const path = join(root, projectPaths.config);
  if (!existsSync(path)) return undefined;
  const pin = parse(readFileSync(path, "utf8")).tool as unknown as ToolPin | undefined;
  if (pin !== undefined) toolSpecification(pin);
  return pin;
}

/** Package identity and npm installation metadata take precedence over inherited dispatch context. */
export function executingToolPin(distribution: string): ToolPin | undefined {
  const source = readDistributionSource(distribution);
  const packaged = source ? toolPin(source) : undefined;
  for (let parent = distribution; ; parent = resolve(parent, "..")) {
    const lock = join(parent, "package-lock.json");
    if (relative(parent, distribution).split(sep).join("/").startsWith("node_modules/") && existsSync(lock)) {
      const document = JSON.parse(readFileSync(lock, "utf8")) as { packages?: Record<string, { resolved?: string }> };
      const entry = document.packages?.[relative(parent, distribution).split(sep).join("/")];
      const pin = specificationPin(entry?.resolved);
      if (pin) {
        if (packaged && !sameToolPin(packaged, pin))
          throw new Error("Workbench package source identity conflicts with npm installation metadata");
        return packaged ?? pin;
      }
    }
    if (resolve(parent, "..") === parent) break;
  }
  return packaged ?? specificationPin(process.env.WORKBENCH_EXECUTING_SPEC);
}
