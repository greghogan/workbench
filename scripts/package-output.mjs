import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const receipt = ".workbench-package.json";
const identity = { schema_version: 1, kind: "workbench-distribution" };
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

/** Build privately, then replace only an output previously owned by this packager. */
export function packageOutput(source, destination, build) {
  const root = resolve(source);
  const output = resolve(destination);
  if (within(output, root) || (within(root, output) && !within(join(root, "dist"), output)))
    throw new Error("Package output must be below dist or outside the source checkout");
  for (let path = output; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error(`Package output must not traverse a symlink: ${path}`);
    if (dirname(path) === path) break;
  }
  mkdirSync(dirname(output), { recursive: true });
  const lock = `${output}.lock`;
  mkdirSync(lock);
  let stage;
  let backup;
  let published = false;
  try {
    if (existsSync(output)) {
      const marker = join(output, receipt);
      if (
        !existsSync(marker) ||
        lstatSync(marker).isSymbolicLink() ||
        JSON.stringify(JSON.parse(readFileSync(marker, "utf8"))) !== JSON.stringify(identity)
      )
        throw new Error(`Refusing to replace an unowned package directory: ${output}`);
    }
    stage = mkdtempSync(join(dirname(output), ".workbench-package-"));
    writeFileSync(join(stage, receipt), `${JSON.stringify(identity)}\n`, { flag: "wx" });
    build(stage);
    if (
      lstatSync(join(stage, receipt)).isSymbolicLink() ||
      readFileSync(join(stage, receipt), "utf8") !== `${JSON.stringify(identity)}\n`
    )
      throw new Error("Package builder changed its ownership receipt");
    if (existsSync(output)) {
      backup = join(lock, "previous");
      renameSync(output, backup);
    }
    try {
      renameSync(stage, output);
      published = true;
    } catch (error) {
      if (backup) renameSync(backup, output);
      throw error;
    }
    stage = undefined;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    // Retain the previous package if a failed replacement also failed to restore it.
    if (published || !backup || !existsSync(backup)) rmSync(lock, { recursive: true, force: true });
  }
}
