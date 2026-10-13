import { cpSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Compare filesystem revisions, including identical content freshly written by a target. */
export function reportState(directory) {
  const state = {};
  const visit = (path) => {
    const info = lstatSync(path, { bigint: true });
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (info.isFile()) {
      Object.defineProperty(state, relative(directory, path), {
        // Ownership repair in managed launchers changes ctime even for stale reports.
        value: [info.dev, info.ino, info.size, info.mtimeNs].join(":"),
        enumerable: true,
      });
    } else throw new Error(`${path}: CI reports must contain only real files and directories`);
  };
  if (lstatSync(directory, { throwIfNoEntry: false })) visit(directory);
  return state;
}

/** Previous targets' reports and saved baselines are not evidence from this execution. */
export function collectReports(directory, destination, before) {
  for (const [name, revision] of Object.entries(reportState(directory))) {
    if (before[name] === revision) continue;
    const output = join(destination, name);
    mkdirSync(dirname(output), { recursive: true });
    cpSync(join(directory, name), output);
  }
}
