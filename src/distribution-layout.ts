import { maintainerOutput } from "../scripts/tooling-artifacts.mjs";
import { relativePath } from "./paths.js";
import { publicationTarget } from "../scripts/file-publication.mjs";
const generated = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".bundle",
  ".pnpm-store",
  "target",
  "build",
  "dist",
  "coverage",
  ".direnv",
  ".envrc.local",
  ".venv",
  "__pycache__",
  "local.toml",
  ".collections",
  ".local-collections",
]);

/** Release and rehearsal copies share payload exclusions, including personal state. */
export function distributionPathIncluded(path: string): boolean {
  path = path.replaceAll("\\", "/");
  if (publicationTarget(path) !== undefined) return false;
  return (
    !maintainerOutput(path) &&
    path
      .split("/")
      .every((part) => !generated.has(part) && !/\.(?:sw[a-z]|pyc|profraw|profdata|tsbuildinfo|egg-info)$/.test(part))
  );
}
export function distributionFiles(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string" && entry !== "."))
    throw new Error("Package files must name relative paths inside the source checkout");
  for (const path of value) relativePath(path, "distribution files");
  if (new Set(value).size !== value.length) throw new Error("Repeated distribution file");
  return value;
}
/** Minimal fixture distributions without an explicit files declaration retain the complete runtime payload. */
export const runtimeFiles = [
  "bin",
  "bundle",
  "scripts",
  "src",
  "tests",
  "languages",
  "skills",
  "examples",
  "demo",
  "LICENSE",
  "README.md",
  "docs",
  "pnpm-lock.yaml",
  ".node-version",
  ".tool-versions",
  ".githooks",
  "Makefile",
];
