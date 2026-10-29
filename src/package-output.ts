import { publishDirectory } from "../scripts/directory-publication.mjs";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";
import { errorFrom } from "../scripts/values.mjs";
import { readBoundedFile } from "./file-reads.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const receipt = ".workbench-package.json";
const identity = { schema_version: 1, kind: "workbench-distribution" };
const within = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

interface PackageCandidate {
  directory: string;
  publish(): void;
  close(): void;
}
function finishCandidate(candidate: PackageCandidate, failure: { error: unknown } | undefined): void {
  try {
    candidate.close();
  } catch (cleanup) {
    if (failure) throw combineFailures(failure.error, cleanup, "Package construction and cleanup failed");
    throw cleanup;
  }
  if (failure) throw errorFrom(failure.error);
}
/** The same ownership checks protect synchronous and asynchronous builders. */
function packageCandidate(source: string, destination: string): PackageCandidate {
  const root = realpathSync(source),
    requested = resolve(destination),
    temporary = resolve(tmpdir());
  const output = within(temporary, requested)
    ? resolve(realpathSync(temporary), relative(temporary, requested))
    : requested;
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
  let directory: string | undefined;
  const previous = join(lock, "previous");
  let published = false;
  try {
    if (existsSync(output)) {
      const marker = join(output, receipt),
        metadata = lstatSync(marker, { throwIfNoEntry: false });
      if (
        !metadata ||
        metadata.isSymbolicLink() ||
        JSON.stringify(
          JSON.parse(
            readBoundedFile(
              marker,
              Buffer.byteLength(JSON.stringify(identity)) + 1,
              "package ownership marker",
            ).toString("utf8"),
          ),
        ) !== JSON.stringify(identity)
      )
        throw new Error(`Refusing to replace an unowned package directory: ${output}`);
    }
    directory = mkdtempSync(join(dirname(output), ".workbench-package-"));
    writeFileSync(join(directory, receipt), `${JSON.stringify(identity)}\n`, { flag: "wx" });
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
  const stage = directory;
  return {
    directory: stage,
    publish() {
      if (
        lstatSync(join(stage, receipt)).isSymbolicLink() ||
        readBoundedFile(
          join(stage, receipt),
          Buffer.byteLength(JSON.stringify(identity)) + 1,
          "package ownership marker",
        ).toString("utf8") !== `${JSON.stringify(identity)}\n`
      )
        throw new Error("Package builder changed its ownership receipt");
      publishDirectory(stage, output, previous);
      published = true;
    },
    close() {
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      if (published || !existsSync(previous)) rmSync(lock, { recursive: true, force: true });
    },
  };
}
/** Build privately, then replace only an output previously owned by this packager. */
export function packageOutput(source: string, destination: string, build: (output: string) => void): void {
  const candidate = packageCandidate(source, destination);
  let failure: { error: unknown } | undefined;
  try {
    build(candidate.directory);
    candidate.publish();
  } catch (error) {
    failure = { error };
  }
  finishCandidate(candidate, failure);
}
export async function packageOutputAsync(
  source: string,
  destination: string,
  build: (output: string) => Promise<void>,
): Promise<void> {
  const candidate = packageCandidate(source, destination);
  let failure: { error: unknown } | undefined;
  try {
    await build(candidate.directory);
    candidate.publish();
  } catch (error) {
    failure = { error };
  }
  finishCandidate(candidate, failure);
}
