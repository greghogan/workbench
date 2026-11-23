import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { storeTarget, type StoreManager } from "./managed-contract.mjs";
import { captureOwnedChild, processCancellation, runOwnedChild } from "../../../runtime/owned-child.mjs";
import { processFailure } from "../../../runtime/process-outcome.mjs";
import { records, string } from "../../../runtime/values.mjs";

export const managedProfileArchive = "managed-profile.archive";
export const restoredProfileDirectory = "/opt/workbench-restored-environments";
const headerLimit = 256 * 1024;

export interface ManagedProfile {
  path: string;
  profile: string;
  runtime?: string;
  manager?: string;
}

interface ArchiveHeader {
  version: 1;
  builder: StoreManager;
  architecture: "x64" | "arm64";
  kind: "toolchain" | "development";
  profiles: ManagedProfile[];
}

function storePath(builder: StoreManager, path: unknown, profile = true): string {
  if (!storeTarget(builder, path) || (profile && path.endsWith(".drv")))
    throw new Error(`${builder} profile must refer to an immutable store output`);
  return path;
}

function profileRoots(builder: StoreManager, value: unknown): ManagedProfile[] {
  const profiles = records(value, "Invalid managed profile archive roots").map((entry) => {
    const path = string(entry.path, "Missing project path");
    if (
      path !== "." &&
      (/[\\\p{Cc}]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
    )
      throw new Error("Invalid project path in managed profile archive");
    const profile = storePath(builder, entry.profile);
    if (builder === "guix")
      return { path, profile, runtime: storePath(builder, entry.runtime), manager: storePath(builder, entry.manager) };
    if (entry.runtime !== undefined || entry.manager !== undefined) throw new Error("Unexpected Nix profile runtime");
    return { path, profile };
  });
  if (!profiles.length || new Set(profiles.map(({ path }) => path)).size !== profiles.length)
    throw new Error("Managed profile archive needs distinct project paths");
  return profiles;
}

function profilePaths(profiles: ManagedProfile[]): string[] {
  return [...new Set(profiles.flatMap(({ profile, runtime, manager }) => [profile, runtime, manager]))].filter(
    (path): path is string => path !== undefined,
  );
}

async function storeClosure(builder: StoreManager, roots: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const command = builder === "nix" ? "nix-store" : "guix";
  const args = builder === "nix" ? ["--query", "--requisites"] : ["gc", "--requisites"];
  const listed = await captureOwnedChild(command, [...args, ...roots], { signal, env, cwd: process.cwd() });
  const issue = processFailure(command, listed, listed);
  if (issue) throw issue;
  const closure = listed.stdout
    .trim()
    .split(/\r?\n/)
    .map((path) => storePath(builder, path, false));
  if (roots.some((path) => !closure.includes(path))) throw new Error(`${builder} closure is missing a selected root`);
  return closure;
}

/** The compact header identifies the selected roots. The rest is the manager's binary archive stream. */
export async function exportManagedProfiles(
  builder: StoreManager,
  profiles: ManagedProfile[],
  output: string,
  env = process.env,
) {
  const architecture = env.WORKBENCH_IMAGE_ARCHITECTURE ?? process.arch;
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("Invalid managed archive architecture");
  const kind = env.WORKBENCH_ARTIFACT_KIND === "toolchain" ? "toolchain" : "development";
  const header: ArchiveHeader = { version: 1, builder, architecture, kind, profiles: profileRoots(builder, profiles) };
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > headerLimit) throw new Error("Managed profile archive metadata is too large");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  const nativeRoots = profilePaths(header.profiles);
  const file = join(output, managedProfileArchive);
  const operation = processCancellation();
  const writer = new AbortController();
  const signal = AbortSignal.any([operation.signal, writer.signal]);
  try {
    const command = builder === "nix" ? "nix-store" : "guix";
    const args =
      builder === "nix"
        ? ["--export", ...(await storeClosure(builder, nativeRoots, env, signal))]
        : ["archive", "--export", "--recursive", ...nativeRoots];
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.concat([prefix, json]));
    } finally {
      await handle.close();
    }
    let writing: Promise<void> | undefined;
    let failed: Error | undefined;
    const outcome = await runOwnedChild(command, args, {
      signal,
      env,
      cwd: process.cwd(),
      stopDescendantsOnExit: true,
      output(stdout, stderr) {
        stderr.pipe(process.stderr, { end: false });
        writing = pipeline(stdout, createWriteStream(file, { flags: "a" }), { signal }).catch((error: unknown) => {
          failed = error instanceof Error ? error : new Error("Failed to write managed archive", { cause: error });
          writer.abort(failed);
        });
      },
    });
    await writing;
    const issue = failed ?? processFailure(command, outcome);
    if (issue) throw issue;
    const archive = await open(file, "r");
    try {
      if ((await archive.stat()).size <= prefix.length + json.length) throw new Error("Empty managed store archive");
    } finally {
      await archive.close();
    }
  } finally {
    operation.close();
  }
}

/** The caller owns the receiving store and has authenticated the archive before importing it. */
export async function importManagedProfiles(
  file: string,
  expected: Parameters<typeof readManagedProfileArchive>[1],
  options: { env?: NodeJS.ProcessEnv; guixVerifier?: string } = {},
): Promise<ManagedProfile[]> {
  const { profiles, payload } = await readManagedProfileArchive(file, expected);
  const env = options.env ?? process.env;
  const { builder } = expected;
  const command = builder === "nix" ? "nix-store" : "guix";
  const operation = processCancellation();
  try {
    const run = async (args: string[]) => {
      const outcome = await runOwnedChild(command, args, {
        cwd: process.cwd(),
        signal: operation.signal,
        env,
        input: payload(),
        stopDescendantsOnExit: true,
        output(stdout, stderr) {
          stdout.resume();
          stderr.pipe(process.stderr, { end: false });
        },
      });
      const issue = processFailure(command, outcome);
      if (issue) throw issue;
    };
    // The native import RPC can accept untrusted signatures. Check the entire stream against the recipient's ACL first.
    if (builder === "guix") {
      if (!options.guixVerifier) throw new Error("Guix archive import requires its signature verifier");
      await run(["repl", options.guixVerifier]);
    }
    await run(builder === "nix" ? ["--import"] : ["archive", "--import"]);
    await storeClosure(builder, profilePaths(profiles), env, operation.signal);
    return profiles;
  } finally {
    operation.close();
  }
}

/** Call after authenticating the whole artifact. Reject mismatched roots before admitting a manager command. */
export async function readManagedProfileArchive(
  file: string,
  expected: Omit<ArchiveHeader, "version" | "profiles"> & { roots: string[] },
) {
  const handle = await open(file, "r");
  try {
    const status = await handle.stat();
    const prefix = Buffer.alloc(4);
    if (!status.isFile() || (await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length)
      throw new Error("Truncated managed profile archive");
    const length = prefix.readUInt32BE();
    if (!length || length > headerLimit || prefix.length + length >= status.size)
      throw new Error("Invalid managed profile archive header size");
    const metadata = Buffer.alloc(length);
    if ((await handle.read(metadata, 0, length, prefix.length)).bytesRead !== length)
      throw new Error("Truncated managed profile metadata");
    const value = JSON.parse(metadata.toString("utf8")) as Partial<ArchiveHeader> | null;
    if (
      value?.version !== 1 ||
      value.builder !== expected.builder ||
      value.architecture !== expected.architecture ||
      value.kind !== expected.kind
    )
      throw new Error("Managed profile archive does not match the selected manager, architecture, and kind");
    const profiles = profileRoots(expected.builder, value.profiles);
    if (profiles.length !== expected.roots.length || profiles.some(({ path }, index) => path !== expected.roots[index]))
      throw new Error("Managed profile archive does not match the selected project roots");
    return {
      profiles,
      payload: () => createReadStream(file, { start: prefix.length + length }),
    };
  } finally {
    await handle.close();
  }
}
