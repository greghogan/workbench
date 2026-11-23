import { isMainScript } from "./script-entry.mjs";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const toolLocations = [
  "cache/toolchains",
  "cache/uv-python",
  "cache/package-managers",
  "cache/container-tools",
  "cache/ci/rustup",
  "cache/ci/cargo/bin",
];

export function copyPreparedTools(source: string, output: string) {
  if (existsSync(output)) throw new Error("Prepared tool output already exists");
  mkdirSync(output, { recursive: true });
  for (const location of toolLocations) {
    const path = join(source, location);
    if (!existsSync(path)) continue;
    const destination = join(output, location);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(path, destination, { recursive: true, verbatimSymlinks: true });
  }
}

/** Copy retained inputs into disjoint layer trees without copying disposable build and dependency caches. */
export function splitPreparedInputs(source: string, tools: string, dependencies: string) {
  source = resolve(source);
  tools = resolve(tools);
  dependencies = resolve(dependencies);
  const paths = [source, tools, dependencies];
  if (
    paths.some((path, index) =>
      paths.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (relative(path, other) === "" ||
            (!isAbsolute(relative(path, other)) &&
              relative(path, other) !== ".." &&
              !relative(path, other).startsWith(`..${sep}`))),
      ),
    )
  )
    throw new Error("Prepared layer directories must be distinct and must not contain one another");
  if (existsSync(tools) || existsSync(dependencies)) throw new Error("Prepared layer output already exists");
  if (!lstatSync(source).isDirectory()) throw new Error("Prepared inputs must be a directory, not a file or link");
  const omitted = new Set([join(source, "cache/builds"), join(source, "cache/dependencies")]);
  const links = new Map<string, string>();
  const duplicates: [string, string][] = [];
  cpSync(source, dependencies, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path, destination) => {
      if (omitted.has(path)) return false;
      const stat = lstatSync(path, { bigint: true });
      if (stat.isFile() && stat.nlink > 1n && stat.ino > 0n) {
        const identity = `${String(stat.dev)}:${String(stat.ino)}`;
        const first = links.get(identity);
        if (first) duplicates.push([first, destination]);
        else links.set(identity, destination);
      }
      return true;
    },
  });
  // fs.cp copies each hard link independently; restore sharing before partitioning the layer trees.
  for (const [first, duplicate] of duplicates) {
    rmSync(duplicate);
    linkSync(first, duplicate);
  }
  mkdirSync(tools, { recursive: true });
  for (const name of toolLocations) {
    const path = join(dependencies, name);
    if (!existsSync(path)) continue;
    const destination = join(tools, name);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(path, destination);
  }
}
if (isMainScript(import.meta.url)) {
  const [source, tools, dependencies] = process.argv.slice(2);
  if (!source || !tools || !dependencies) throw new Error("Supply source, tools, and dependency layer directories");
  if (source === "--tools-only") copyPreparedTools(tools, dependencies);
  else splitPreparedInputs(source, tools, dependencies);
}
