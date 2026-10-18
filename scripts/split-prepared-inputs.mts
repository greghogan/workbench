import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Partition one completed snapshot into disjoint layer trees, retaining the final filesystem layout. */
export function splitPreparedInputs(source: string, tools: string, dependencies: string) {
  const paths = [source, tools, dependencies].map((path) => resolve(path));
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
    throw new Error("Prepared layer directories must be distinct siblings");
  if (existsSync(tools) || existsSync(dependencies)) throw new Error("Prepared layer output already exists");
  mkdirSync(tools, { recursive: true });
  for (const name of [
    "cache/toolchains",
    "cache/uv-python",
    "cache/package-managers",
    "cache/container-tools",
    "cache/ci/rustup",
    "cache/ci/cargo/bin",
  ]) {
    const path = join(source, name);
    if (!existsSync(path)) continue;
    const destination = join(tools, name);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(path, destination);
  }
  renameSync(source, dependencies);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, tools, dependencies] = process.argv.slice(2);
  if (!source || !tools || !dependencies) throw new Error("Supply source, tools, and dependency layer directories");
  splitPreparedInputs(source, tools, dependencies);
}
