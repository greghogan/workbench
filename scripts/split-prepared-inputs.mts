import { isMainScript } from "./script-entry.mjs";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const toolLocations = ["cache/uv-python", "cache/container-tools", "cache/ci/rustup", "cache/ci/cargo/bin"];

function toolEntries(source: string): string[] {
  const path = "cache/toolchains";
  // These are installed while acquiring a C/C++ or PHP project's locked dependencies.
  const preparedProjectTools = new Set(["vcpkg", "xdebug"]);
  return [
    ...toolLocations,
    ...(existsSync(join(source, path))
      ? readdirSync(join(source, path))
          .filter((name) => !preparedProjectTools.has(name))
          .map((name) => `${path}/${name}`)
      : []),
  ];
}

export function copyPreparedTools(source: string, output: string) {
  if (existsSync(output)) throw new Error("Prepared tool output already exists");
  mkdirSync(output, { recursive: true });
  copyPreparedPaths(
    toolEntries(source)
      .filter((location) => existsSync(join(source, location)))
      .map((location) => [join(source, location), join(output, location)]),
  );
}

function copyPreparedPaths(paths: [string, string][], omitted: ReadonlySet<string> = new Set()) {
  const links = new Map<string, string>();
  const duplicates: [string, string][] = [];
  for (const [source, destination] of paths) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path, target) => {
        if (omitted.has(path)) return false;
        const stat = lstatSync(path, { bigint: true });
        if (stat.isFile() && stat.nlink > 1n && stat.ino > 0n) {
          const key = `${String(stat.dev)}:${String(stat.ino)}`;
          const first = links.get(key);
          if (first) duplicates.push([first, target]);
          else links.set(key, target);
        }
        return true;
      },
    });
  }
  // Compiler installation receipts depend on hard links surviving the layer copy.
  for (const [first, duplicate] of duplicates) {
    rmSync(duplicate);
    linkSync(first, duplicate);
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
  copyPreparedPaths([[source, dependencies]], omitted);
  mkdirSync(tools, { recursive: true });
  for (const name of toolEntries(dependencies)) {
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
