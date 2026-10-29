import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { publishCheckedFiles } from "./file-publication.mjs";
import { required } from "./values.mjs";

type JavaSources = ReadonlyMap<string, { bytes: Buffer; mode: number }>;

/** Capture the formatter's input before staging; links could let the staged formatter modify original files. */
export function snapshotJavaSources(directory: string): JavaSources {
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Java formatter inputs must not be symbolic links");
  const sources = new Map<string, { bytes: Buffer; mode: number }>();
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Java formatter inputs must not be symbolic links");
    if (!entry.isFile() || !entry.name.endsWith(".java")) continue;
    const path = join(entry.parentPath, entry.name);
    sources.set(relative(directory, path), { bytes: readFileSync(path), mode: lstatSync(path).mode & 0o777 });
  }
  return sources;
}

/** Publish only formatter changes, rejecting edits made since the input snapshot. */
export function publishJavaFormatting(directory: string, stage: string, before: JavaSources): void {
  directory = resolve(directory);
  const formatted = snapshotJavaSources(stage);
  if (formatted.size !== before.size || [...before.keys()].some((path) => !formatted.has(path)))
    throw new Error("Java formatter changed the source inventory; original files were preserved");
  const changed = [...formatted].filter(([path, { bytes }]) => !bytes.equals(required(before.get(path), path).bytes));
  const check = (name: string) => {
    const path = resolve(directory, name);
    for (let current = path; ; current = dirname(current)) {
      const metadata = lstatSync(current, { throwIfNoEntry: false });
      if (
        !metadata ||
        metadata.isSymbolicLink() ||
        (current === path
          ? !metadata.isFile() || (metadata.mode & 0o777) !== required(before.get(name), name).mode
          : !metadata.isDirectory())
      )
        throw new Error(`${name}: source changed during formatting; concurrent changes were preserved`);
      if (current === directory) break;
      if (dirname(current) === current) throw new Error("Java formatting destination escapes its source directory");
    }
    if (!readFileSync(path).equals(required(before.get(name), name).bytes))
      throw new Error(`${name}: source changed during formatting; concurrent changes were preserved`);
  };
  publishCheckedFiles(
    changed.map(([name, { bytes }]) => ({
      path: join(directory, name),
      contents: bytes,
      expected: required(before.get(name), name).bytes,
      mode: required(before.get(name), name).mode,
    })),
    (path) => {
      check(relative(directory, path));
    },
  );
}

/** Keep the source newline contract independent of the selected formatter's defaults. */
export function canonicalJavaSources(directory: string, write = false): void {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".java")) continue;
    const path = join(entry.parentPath, entry.name);
    const source = readFileSync(path, "utf8");
    if (!source.includes("\r")) continue;
    if (!write)
      throw new Error(`${relative(directory, path)}: Java sources require LF line endings; run the format-write role`);
    writeFileSync(path, source.replace(/\r\n?/g, "\n"));
  }
}
