import { cpSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { distributionRoot } from "./core.js";

/** Rehearsal checkouts carry their own runtime; retained collection snapshots never contain executables. */
export function materializeDistribution(project: string, destination: string, fallback: string): string {
  const source = fallback || distributionRoot(project);
  const inside = relative(project, source);
  if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`)) return join(destination, inside);
  const output = join(destination, ".git/workbench/runtime");
  if (existsSync(output)) return output;
  mkdirSync(output, { recursive: true });
  for (const name of [
    "bin",
    "bundle",
    "scripts",
    "src",
    "tests",
    "languages",
    "skills",
    "examples",
    "package.json",
    "LICENSE",
    "README.md",
    "docs",
    "pnpm-lock.yaml",
    ".node-version",
    ".tool-versions",
    ".githooks",
    "Makefile",
  ]) {
    if (existsSync(join(source, name)))
      cpSync(join(source, name), join(output, name), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (path) =>
          !/(?:^|[/\\])(?:node_modules|vendor|build|target|dist|coverage|\.git|\.direnv|\.envrc\.local)(?:[/\\]|$)/.test(
            relative(source, path),
          ),
      });
  }
  return output;
}
