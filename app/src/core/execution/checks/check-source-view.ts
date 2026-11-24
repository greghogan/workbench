import { chmodSync, copyFileSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownedPath } from "../../runtime/paths.js";
import { fileDigest, type CheckSourceEntry } from "./check-inputs.js";

/** Materialize only the entries that supplied the check's source fingerprint. */
export function materializeCheckSource(root: string, view: string, entries: readonly CheckSourceEntry[]): void {
  for (const entry of entries) {
    const [name, kind, captured] = entry;
    const target = ownedPath(view, name);
    if (kind === "directory") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (kind === "gitlink") throw new Error(`Cannot materialize a submodule as a scoped input: ${name}`);
    if (kind === "link") continue;
    const source = join(root, name);
    if (!lstatSync(source).isFile()) throw new Error(`Scoped input changed during capture: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    if (fileDigest(target) !== captured) throw new Error(`Scoped input changed during capture: ${name}`);
    // The backend enforces read-only access. Copies made by the check keep normal checkout modes.
    if (process.platform !== "win32") chmodSync(target, kind === "executable" ? 0o755 : 0o644);
  }
  // Copy links after their captured targets to avoid traversing user-provided links when creating files.
  for (const [name, kind, captured] of entries) {
    if (kind !== "link") continue;
    if (readlinkSync(join(root, name)) !== captured) throw new Error(`Scoped input changed during capture: ${name}`);
    const target = ownedPath(view, name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(captured, target, "file");
  }
}
