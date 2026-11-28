import { constants, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { copyFile, link } from "node:fs/promises";
import { verifyStagedSource } from "../../../../../.githooks/verify-staged.mjs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { ownedPath } from "../../runtime/paths.js";
import type { CheckSourceEntry } from "./check-inputs.js";
import { copyFileDigest, hashFile, mapFileIO } from "../../runtime/file-reads.js";

function capturedPath(root: string, name: string): string {
  ownedPath(root, posix.dirname(name));
  return join(root, name);
}

function matchesMode(mode: number, kind: "file" | "executable"): boolean {
  return !!(mode & 0o111) === (kind === "executable");
}

/** Materialize only the entries that supplied the check's source fingerprint. */
export async function materializeCheckSource(
  root: string,
  view: string,
  entries: readonly CheckSourceEntry[],
  sharedReadOnlyFiles?: Map<string, string>,
): Promise<void> {
  const files: Extract<CheckSourceEntry, [string, "file" | "executable", string, "staged"?]>[] = [];
  for (const entry of entries) {
    const [name, kind] = entry;
    if (kind === "directory") {
      if (!lstatSync(ownedPath(root, name)).isDirectory())
        throw new Error("Scoped input changed during capture: " + name);
      mkdirSync(ownedPath(view, name), { recursive: true });
    } else if (kind === "gitlink") throw new Error(`Cannot materialize a submodule as a scoped input: ${name}`);
    else if (kind !== "link") files.push(entry);
  }
  await mapFileIO(files, async ([name, kind, captured]) => {
    const target = ownedPath(view, name);
    mkdirSync(dirname(target), { recursive: true });
    const key = JSON.stringify([name, kind, captured]);
    const previous = sharedReadOnlyFiles?.get(key);
    if (previous) {
      // Both aliases live in Workbench-owned source views and are mounted read-only.
      try {
        await link(previous, target);
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        if (!code || !["EXDEV", "EPERM", "EOPNOTSUPP", "ENOSYS", "EMLINK"].includes(code)) throw error;
        await copyFile(previous, target, constants.COPYFILE_EXCL);
      }
      return;
    }
    const { digest, mode } = await copyFileDigest(ownedPath(root, name), target);
    if (digest !== captured || (process.platform !== "win32" && !matchesMode(mode, kind)))
      throw new Error("Scoped input changed during capture: " + name);
    sharedReadOnlyFiles?.set(key, target);
  });
  // Copy links after their captured targets to avoid traversing user-provided links when creating files.
  for (const [name, kind, captured] of entries) {
    if (kind !== "link") continue;
    if (readlinkSync(capturedPath(root, name)) !== captured)
      throw new Error("Scoped input changed during capture: " + name);
    const target = ownedPath(view, name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(captured, target, "file");
  }
}

/** Check that preparation and execution preserved the hook's tracked files before saving evidence. */
export function checkStagedSourceUnchanged(root: string): void {
  const { WORKBENCH_STAGED_INDEX, WORKBENCH_REVIEW_TREE, WORKBENCH_LOCAL_CONFIG_ROOT } = process.env;
  if (!WORKBENCH_STAGED_INDEX || !WORKBENCH_REVIEW_TREE || !WORKBENCH_LOCAL_CONFIG_ROOT) return;
  verifyStagedSource(WORKBENCH_LOCAL_CONFIG_ROOT, root, WORKBENCH_STAGED_INDEX, WORKBENCH_REVIEW_TREE);
}

/** The hook exposes its private backing tree read-only. Other checkout paths use verified capture. */
export function stagedCheckSource(project: string, source: string | undefined): string | undefined {
  if (process.platform !== "linux" || !source || !isAbsolute(source) || source === project) return;
  const mounts = readFileSync("/proc/self/mountinfo", "utf8");
  const readOnly = (path: string) =>
    mounts.split("\n").some((line) => {
      const [, , , , mount, flags] = line.split(" ", 6);
      return (
        mount?.replace(/\\([0-7]{3})/g, (_escape, octal: string) => String.fromCharCode(parseInt(octal, 8))) === path &&
        flags?.split(",").includes("ro")
      );
    });
  return readOnly(source) ? source : undefined;
}

/** Project the verified staged allowlist, merging only directories whose entire tree is declared. */
export async function stagedCheckMounts(
  staged: string,
  project: string,
  view: string,
  entries: readonly CheckSourceEntry[],
  privatePaths: readonly string[],
  sharedReadOnlyFiles?: Map<string, string>,
): Promise<string[]> {
  interface Node {
    children: Map<string, Node>;
    entry?: CheckSourceEntry;
  }
  const root: Node = { children: new Map() };
  for (const entry of entries) {
    let tree = root;
    for (const part of entry[0] === "." ? [] : entry[0].split("/")) {
      let child = tree.children.get(part);
      if (!child) tree.children.set(part, (child = { children: new Map() }));
      tree = child;
    }
    tree.entry = entry;
  }
  const changed: CheckSourceEntry[] = [];
  const visit = (tree: Node, name: string, stagedParent: boolean): { complete: boolean; args: string[] } => {
    const source = join(staged, name);
    const destination = join(project, name);
    const metadata = stagedParent ? lstatSync(source, { throwIfNoEntry: false }) : undefined;
    if (tree.entry && tree.entry[1] !== "directory") {
      const [, kind, expected] = tree.entry;
      if (kind === "gitlink") throw new Error("Cannot mount a staged submodule as a scoped input: " + name);
      const complete =
        kind === "link"
          ? !!metadata?.isSymbolicLink() && readlinkSync(source) === expected
          : !!metadata?.isFile() &&
            matchesMode(metadata.mode, kind) &&
            (tree.entry[3] === "staged" ||
              hashFile(source, undefined, "scoped input", { algorithm: "sha256" }) === expected);
      // Tracked files are fingerprinted from the read-only checkout. Generated files can differ in the overlay.
      if (!complete) {
        if (kind !== "link" && tree.entry[3] === "staged") throw new Error("Staged input changed: " + name);
        changed.push(tree.entry);
      }
      const args =
        kind === "link"
          ? ["--symlink", expected, destination]
          : ["--ro-bind", complete ? source : join(view, name), destination];
      return { complete, args };
    }
    const stagedDirectory = !!metadata?.isDirectory();
    if (!stagedDirectory && tree.entry) changed.push(tree.entry);
    const children = [...tree.children].map(([part, child]) => visit(child, posix.join(name, part), stagedDirectory));
    const complete =
      name !== "." &&
      stagedDirectory &&
      children.every((child) => child.complete) &&
      !privatePaths.some((path) => path === destination || path.startsWith(destination + "/")) &&
      readdirSync(source).every((part) => tree.children.has(part));
    return {
      complete,
      args: complete
        ? ["--ro-bind", source, destination]
        : ["--dir", destination, ...children.flatMap(({ args }) => args)],
    };
  };
  const mounts = visit(root, ".", true).args;
  // Generated inputs can be newer than the original checkout. Copy only those entries from the overlay.
  await materializeCheckSource(project, view, changed, sharedReadOnlyFiles);
  return mounts;
}
