import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { imageHash } from "./image-contract.js";
import {
  artifactHost,
  type ArtifactPlanEntry,
  type FileArtifactRecipe,
  type NativeArchiveRecipe,
  type StoreArtifactRecipe,
} from "./artifact-catalog.js";
import {
  offlineInputs,
  offlineProfile,
  openStoreArchiveShell,
  prepareStoreArchive,
  verifyStoreArchive,
} from "./offline-profiles.js";
import { restoreNativeArchive, runNativeArchivePreparation, writeNativeArchive } from "./native-archive.js";
import { readManagedProfileArchive } from "../execution/environments/managed/profile-transfer.mjs";
import { buildPaths } from "./builds.js";
import { distributionRoot, rootOf } from "../projects/project-context.js";
import { readConfig, readLanguageRoots, selectProject } from "../projects/project-configuration.js";
import { hashFile, readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import { isRecord, record, string } from "../runtime/values.mjs";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { CacheBusy, CacheLockState, inspectCacheMetadataLock, withCacheLock } from "../storage/cache-lock.js";
import {
  inspectCacheOperations,
  recoverCacheOperation,
  removeOwnedCache,
  withCacheInstallation,
} from "../storage/cache-operations.js";
import { cacheGenerationMarker, cacheSizeMarker } from "../storage/cache-generation.mjs";
import { userConfigValues } from "../configuration/user-config.js";
import { keptCacheAssets } from "../projects/project-registry.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics/diagnostics.mjs";
import { CheckCancellation } from "../execution/checks/check-cancellation.js";
import { runCommandAsync } from "../execution/checks/check-command.js";
import { gitRevision } from "../git/refs.js";
import { gitBytes } from "../git/git-snapshot.js";
import { createHash } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { snapshotCIProject } from "../execution/ci/ci-workspace.js";
import { CILifecycle } from "../execution/ci/support/ci-lifecycle.mjs";
import { materializeDistribution } from "../distribution/runtime-distribution.js";
import { processCancellation, runOwnedChild } from "../runtime/owned-child.mjs";
import { processFailure } from "../runtime/process-outcome.mjs";
import { required } from "../runtime/invariants.js";
import { ciCacheEnvironment } from "../execution/ci/support/ci-layout.mjs";
import { userDirectory } from "../storage/storage.js";
import { packReleaseDirectory, unpackReleaseDirectory } from "./release-directory.js";
import { withExecutionEnvironment } from "../execution/environments/execution-context.js";
import { executionEnvironment } from "../execution/environments/execution-resources.js";

const manifestName = "workbench-artifact.json";
const manifestLimit = 256 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const fileExtensions = {
  "nix-export": "nix-export",
  "guix-export": "guix-export",
  squashfs: "squashfs",
  dmg: "dmg",
  apptainer: "sif",
} as const;

function fileRecipe(row: ArtifactPlanEntry): FileArtifactRecipe | StoreArtifactRecipe | NativeArchiveRecipe {
  if ("offlineProfile" in row.definition) throw new InvalidInput(`${row.profile}: use the OCI image operation`);
  return row.definition;
}

function nativeSelection(root: string, row: ArtifactPlanEntry, recipe: NativeArchiveRecipe) {
  if (row.builder !== "native" || row.kind === "release" || !row.platform.startsWith("linux-"))
    throw new InvalidInput("Native input archives require a Linux toolchain or development profile");
  const profile = offlineProfile(root, recipe.nativeProfile);
  if (profile.builder !== "native" || (profile.offline.kind ?? "development") !== row.kind)
    throw new InvalidInput("Native input archive does not match the selected profile");
  return { profile, kind: row.kind, architecture: row.platform === "linux-arm64" ? "arm64" : "x64" };
}

function preparedInputArchive(row: ArtifactPlanEntry): boolean {
  return "storeProfile" in row.definition || "nativeProfile" in row.definition;
}

function storeSelection(root: string, row: ArtifactPlanEntry, recipe: StoreArtifactRecipe) {
  if ((row.builder !== "nix" && row.builder !== "guix") || row.kind === "release")
    throw new InvalidInput("Managed store exports require a toolchain or development profile");
  const profile = offlineProfile(root, recipe.storeProfile);
  if (profile.builder !== row.builder || (profile.offline.kind ?? "development") !== row.kind)
    throw new InvalidInput("Managed store export does not match the selected profile");
  return {
    profile,
    expected: {
      builder: row.builder,
      architecture: row.platform === "linux-arm64" ? ("arm64" as const) : ("x64" as const),
      kind: row.kind,
      roots: profile.offline.paths ?? readLanguageRoots(root).map(({ path }) => path),
    },
  };
}

export function artifactFileName(row: ArtifactPlanEntry): string {
  const extension =
    row.archive ??
    (row.format in fileExtensions ? fileExtensions[row.format as keyof typeof fileExtensions] : undefined);
  if (!extension) throw new InvalidInput(`${row.profile}: ${row.format} is not a portable file artifact`);
  return `artifact.${extension}`;
}

function sourceFiles(root: string, names: readonly string[], repository = gitRevision(root, "HEAD") !== undefined) {
  const files = new Map<string, [string, string, number]>();
  const inspect = (name: string) => {
    const path = ownedPath(root, name);
    const metadata = lstatSync(path);
    if (metadata.isDirectory()) {
      const children = repository
        ? gitBytes(root, [
            "--literal-pathspecs",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            name,
          ])
            .toString()
            .split("\0")
            .filter(Boolean)
        : readdirSync(path).map((child) => `${name}/${child}`);
      for (const child of new Set(children)) if (existsSync(ownedPath(root, child))) inspect(child);
    } else if (metadata.isFile()) files.set(name, [name, hashFile(path), metadata.mode & 0o111]);
    else throw new InvalidInput(`${name}: expected a regular recipe input`);
  };
  for (const name of [...names].sort()) inspect(name);
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}

export function recipeKey(row: ArtifactPlanEntry, toolchain?: string) {
  const recipe = fileRecipe(row);
  return imageHash(
    JSON.stringify([
      row.builder,
      row.workspace,
      row.target,
      row.kind,
      row.format,
      row.requirements,
      row.recipe,
      recipe.owner,
      ...("nativeProfile" in recipe
        ? [recipe.nativeProfile, recipe.bootstrapImage]
        : "storeProfile" in recipe
          ? [recipe.storeProfile]
          : [recipe.inputs, recipe.build, ...(recipe.package ? [recipe.package] : [])]),
      toolchain ?? null,
      ...(row.releaseTag ? [row.releaseTag] : []),
    ]),
  );
}

/** Only an exact, clean checkout can claim a Git revision as its source. */
export function artifactSourceRevision(root: string, revision = gitRevision(root, "HEAD")): string | null {
  if (!revision) return null;
  const changed = gitBytes(root, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  return changed.length ? null : revision;
}

function inputKey(
  root: string,
  row: ArtifactPlanEntry,
  toolchain?: string,
  revision = row.kind === "release" ? artifactSourceRevision(root) : null,
  readFiles = (names: readonly string[]) => sourceFiles(root, names),
) {
  const recipe = fileRecipe(row);
  let inputs;
  if ("nativeProfile" in recipe) {
    const { profile, architecture } = nativeSelection(root, row, recipe);
    if (toolchain && profile.toolchain !== toolchain)
      throw new InvalidInput(`${row.profile}: select a recipe configured for toolchain '${toolchain}'`);
    inputs = offlineInputs(root, profile, architecture);
  } else if ("storeProfile" in recipe) {
    const { profile, expected } = storeSelection(root, row, recipe);
    if (toolchain && profile.toolchain !== toolchain)
      throw new InvalidInput(`${row.profile}: select a recipe configured for toolchain '${toolchain}'`);
    inputs = [offlineInputs(root, profile, expected.architecture), profile.offline.prepare];
  } else {
    inputs = readFiles(recipe.inputs);
    if (recipe.package && row.builder !== "native") inputs = [inputs, readConfig(root).checks?.nix_docker_image];
  }
  return imageHash(JSON.stringify([recipeKey(row, toolchain), inputs, row.kind === "release" ? revision : undefined]));
}

function cachePath(root: string, generation: string): string {
  const paths = buildPaths(root, root, "native", {}, false);
  return ownedPath(paths.storageRoot, `artifacts/${imageHash(realpathSync(root))}/${generation}`);
}

export interface FileArtifactManifest {
  version: 1;
  recipe: string;
  inputs: string;
  revision: string | null;
  releaseTag?: string;
  file: string;
  sha256: string;
  bytes: number;
  verification?: {
    platform: string;
    sha256: string;
    verifier: string;
    time: string;
    revision: string | null;
    source?: "transfer";
  };
}

function digest(input: unknown, field: string) {
  const value = string(input, `Missing artifact ${field}`);
  if (!digestPattern.test(value)) throw new InvalidInput(`Invalid artifact ${field}`);
  return value;
}

function decodedRevision(value: unknown): string | null {
  if (value === null || (typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) return value;
  throw new InvalidInput("Invalid artifact source revision");
}

function manifestValue(contents: Buffer) {
  return record(JSON.parse(contents.toString("utf8")), "Invalid artifact manifest");
}

function decodeManifest(
  value: Record<string, unknown>,
  row: ArtifactPlanEntry,
  toolchain?: string,
): FileArtifactManifest {
  if (
    value.version !== 1 ||
    value.recipe !== recipeKey(row, toolchain) ||
    value.file !== artifactFileName(row) ||
    value.releaseTag !== row.releaseTag
  )
    throw new InvalidInput("Artifact manifest does not match the selected recipe, target, kind, and format");
  const bytes = value.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1)
    throw new InvalidInput("Invalid artifact size");
  const revision = decodedRevision(value.revision);
  const sha256 = digest(value.sha256, "digest");
  const proof =
    value.verification === undefined ? undefined : record(value.verification, "Invalid artifact verification");
  const time = proof ? string(proof.time, "Missing verification time") : undefined;
  if (
    proof &&
    (proof.platform !== row.platform ||
      proof.sha256 !== sha256 ||
      (proof.source !== undefined && proof.source !== "transfer") ||
      !Number.isFinite(Date.parse(time ?? "")))
  )
    throw new InvalidInput("Invalid artifact verification");
  return {
    version: 1,
    recipe: value.recipe,
    inputs: digest(value.inputs, "input digest"),
    revision,
    ...(row.releaseTag ? { releaseTag: row.releaseTag } : {}),
    file: value.file,
    sha256,
    bytes,
    ...(time && proof
      ? {
          verification: {
            platform: row.platform,
            sha256,
            time,
            verifier: digest(proof.verifier, "verifier"),
            revision: decodedRevision(proof.revision ?? null),
            ...(proof.source === "transfer" ? { source: "transfer" } : {}),
          },
        }
      : {}),
  };
}

function manifestBytes(directory: string): Buffer {
  return readBoundedFile(join(directory, manifestName), manifestLimit, "artifact manifest");
}

function readManifest(directory: string, row: ArtifactPlanEntry, toolchain?: string): FileArtifactManifest {
  return decodeManifest(manifestValue(manifestBytes(directory)), row, toolchain);
}

function validatePayload(directory: string, manifest: FileArtifactManifest): string {
  const file = ownedPath(directory, manifest.file);
  if (hashFile(file, manifest.bytes, "artifact payload") !== manifest.sha256 || statSync(file).size !== manifest.bytes)
    throw new StateConflict("Artifact payload does not match its manifest");
  return file;
}

function stageArtifactPayload(directory: string, manifest: FileArtifactManifest, stage: string): string {
  copyFileSync(
    join(directory, manifest.file),
    join(stage, manifest.file),
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  );
  return validatePayload(stage, manifest);
}

function encodeManifest(manifest: FileArtifactManifest): string {
  const ordered = (_key: string, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => [name, value[name]]),
        )
      : value;
  return JSON.stringify(manifest, ordered, 2) + "\n";
}

function manifestOutput(directory: string, manifest: FileArtifactManifest): void {
  writeAtomic(join(directory, manifestName), encodeManifest(manifest));
}

function requireLocalHost(row: ArtifactPlanEntry) {
  if (row.platform !== artifactHost())
    throw new InvalidInput(`${row.profile}: ${row.format} requires a ${row.platform} builder or verifier`);
}

async function runRecipe(
  root: string,
  row: ArtifactPlanEntry,
  phase: "build" | "verify",
  output: string,
  toolchain?: string,
  expectedInputs?: string,
  verifiedSha256?: string,
) {
  const recipe = fileRecipe(row);
  const artifact = join(output, artifactFileName(row));
  if ("nativeProfile" in recipe) {
    const { profile, kind } = nativeSelection(root, row, recipe);
    const temporary = mkdtempSync(join(output, ".native-inputs-"));
    const lifecycle = new CILifecycle();
    try {
      const source = join(temporary, "source");
      await snapshotCIProject(root, source, lifecycle);
      if (inputKey(source, row, toolchain) !== (expectedInputs ?? inputKey(root, row, toolchain)))
        throw new StateConflict("Native profile inputs changed while preparing the checkout");
      const cache = join(temporary, "cache");
      if (phase === "verify") await restoreNativeArchive(artifact, cache, kind);
      else mkdirSync(cache, { mode: 0o700 });
      await lifecycle.checkpoint();
      await runNativeArchivePreparation(root, source, cache, profile, recipe.bootstrapImage, kind, phase);
      await lifecycle.checkpoint();
      if (phase === "build") await writeNativeArchive(cache, artifact, kind);
      await lifecycle.checkpoint();
    } finally {
      lifecycle.close();
      rmSync(temporary, { recursive: true, force: true });
    }
    return;
  }
  if (phase === "build" && "storeProfile" in recipe) {
    const { profile, expected } = storeSelection(root, row, recipe);
    await prepareStoreArchive(root, profile.name, expected.architecture, artifact);
    await readManagedProfileArchive(artifact, expected);
    return;
  }
  let commandRoot = root;
  let distribution = distributionRoot(root);
  const env = { ...process.env };
  if ("storeProfile" in recipe) {
    const { expected, profile } = storeSelection(root, row, recipe);
    await readManagedProfileArchive(artifact, expected);
    commandRoot = join(output, "source");
    await snapshotCIProject(root, commandRoot);
    if (inputKey(commandRoot, row, toolchain) !== expectedInputs)
      throw new StateConflict("Managed profile inputs changed while preparing the verification checkout");
    if (recipe.bootstrapImage) {
      await verifyStoreArchive(root, profile, recipe.bootstrapImage, commandRoot, { file: artifact, expected });
      return;
    }
    distribution = materializeDistribution(root, commandRoot, "");
    env.WORKBENCH_OFFLINE = "1";
    env.WORKBENCH_PROJECT_ROOT = commandRoot;
    env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
    env.WORKBENCH_LOCAL_CONFIG_ROOT = root;
    env.WORKBENCH_EPHEMERAL_CHECKOUT = "1";
  }
  const owner = selectProject(commandRoot, recipe.owner);
  const source = rootOf(commandRoot, owner);
  const roots = readLanguageRoots(commandRoot);
  const candidate = roots
    .filter(({ path }) => path === "." || owner.path === path || owner.path.startsWith(path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const directory = candidate ? ownedPath(commandRoot, candidate.path) : source;
  const packaging = "package" in recipe ? recipe.package : undefined;
  let packageDirectory;
  if (packaging) {
    packageDirectory = join(output, "package");
    mkdirSync(packageDirectory, { mode: 0o700 });
    if (phase === "build") {
      env.WORKBENCH_PROJECT_ROOT = root;
      env.WORKBENCH_RELEASE_OUTPUT = packageDirectory;
      Object.assign(env, executionEnvironment(root));
    } else if (packaging.file) {
      copyFileSync(
        artifact,
        ownedPath(packageDirectory, packaging.file),
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
    } else {
      packageDirectory = await unpackReleaseDirectory(
        artifact,
        packageDirectory,
        required(row.archive, "Expected the release archive format"),
        required(verifiedSha256, "Expected the authenticated release archive digest"),
      );
    }
  }
  const variables: Record<string, string> = {
    root: commandRoot,
    source,
    output: packageDirectory ?? output,
    artifact: phase === "verify" ? (packageDirectory ?? artifact) : artifact,
    nix_image: packaging ? (readConfig(root).checks?.nix_docker_image ?? "") : "",
    target: row.target,
    tag: row.releaseTag ?? "",
    kind: row.kind,
    format: row.archive ?? row.format,
    workbench: distribution,
    node: process.execPath,
  };
  const args = phase === "verify" ? recipe.verify : "build" in recipe ? recipe.build : [];
  const command = args.map((arg) =>
    arg.replace(
      /\{(root|source|output|artifact|target|tag|kind|format|workbench|node|nix_image)\}/g,
      (parameter, key: string) => variables[key] ?? parameter,
    ),
  );
  const cancellation = new CheckCancellation("Artifact operation", process.stderr);
  try {
    if ("storeProfile" in recipe) {
      const [executable, ...arguments_] = command;
      const selected = required(executable, "Managed artifact verification needs a command");
      const outcome = await runOwnedChild(selected, arguments_, {
        cwd: output,
        env,
        signal: cancellation.signal,
        stopDescendantsOnExit: true,
        output(stdout, stderr) {
          stdout.pipe(process.stderr, { end: false });
          stderr.pipe(process.stderr, { end: false });
        },
      });
      const failure = processFailure(selected, outcome);
      if (failure) throw failure;
      cancellation.checkpoint();
    } else if (phase === "verify") await cancellation.execute(command, output, env, true);
    else if (packaging && row.builder !== "native") await cancellation.execute(command, directory, env, true);
    else
      await withExecutionEnvironment(env, () =>
        runCommandAsync(
          cancellation,
          directory,
          `artifact ${row.recipe}`,
          command,
          row.builder,
          root,
          toolchain === undefined ? {} : { toolchain },
        ),
      );
    if (phase === "build" && packaging && packageDirectory) {
      if (packaging.file) {
        const result = ownedPath(packageDirectory, packaging.file);
        const files = readdirSync(packageDirectory);
        if (files.length !== 1 || files[0] !== packaging.file || !lstatSync(result).isFile())
          throw new InvalidInput(`Release builder must produce only ${packaging.file}`);
        renameSync(result, artifact);
      } else
        await packReleaseDirectory(
          packageDirectory,
          artifact,
          required(row.archive, "Expected the release archive format"),
          cancellation.signal,
        );
      rmSync(packageDirectory, { recursive: true });
    }
  } finally {
    cancellation.close();
  }
}

function verifierKey(
  root: string,
  row: ArtifactPlanEntry,
  readFiles = (names: readonly string[]) => sourceFiles(root, names),
) {
  const recipe = fileRecipe(row);
  if ("nativeProfile" in recipe) {
    const { profile } = nativeSelection(root, row, recipe);
    return imageHash(JSON.stringify([recipe.bootstrapImage, profile.offline.verify]));
  }
  if ("storeProfile" in recipe && recipe.bootstrapImage) {
    const { profile } = storeSelection(root, row, recipe);
    return imageHash(JSON.stringify([recipe.bootstrapImage, profile.offline.verify]));
  }
  if ("verifyInputs" in recipe) {
    // CI can consume target evidence on another OS. File bytes and Git revision
    // are portable across filesystems with different executable-mode support.
    const files = readFiles(recipe.verifyInputs).map(([name, sha256]) => [name, sha256]);
    return imageHash(JSON.stringify([recipe.verify, recipe.verifyInputs, files]));
  }
  return imageHash(JSON.stringify(recipe.verify));
}

function discardStaleVerification(root: string, manifest: FileArtifactManifest, row: ArtifactPlanEntry) {
  if (manifest.verification && manifest.verification.verifier !== verifierKey(root, row)) delete manifest.verification;
}

function payloadManifest(
  stage: string,
  row: ArtifactPlanEntry,
  inputs: string,
  revision: string | null,
  toolchain?: string,
): FileArtifactManifest {
  const file = artifactFileName(row);
  if (readdirSync(stage).some((name) => name !== file))
    throw new InvalidInput(`Artifact recipe must produce only ${file} in its output directory`);
  const payload = ownedPath(stage, file);
  const sha256 = hashFile(payload, undefined, "artifact payload");
  const bytes = lstatSync(payload).size;
  if (!bytes) throw new InvalidInput("Artifact recipe produced an empty file");
  return {
    version: 1,
    recipe: recipeKey(row, toolchain),
    inputs,
    revision,
    ...(row.releaseTag ? { releaseTag: row.releaseTag } : {}),
    file,
    bytes,
    sha256,
  };
}

async function verifyPayload(
  root: string,
  row: ArtifactPlanEntry,
  directory: string,
  data: FileArtifactManifest,
  toolchain?: string,
) {
  requireLocalHost(row);
  if (preparedInputArchive(row) && inputKey(root, row, toolchain) !== data.inputs)
    throw new StateConflict("Prepared artifact does not match the receiving project profile inputs");
  validatePayload(directory, data);
  const revision = artifactSourceRevision(root);
  const verifier = verifierKey(root, row);
  const scratch = mkdtempSync(join(directory, ".verify-"));
  try {
    // Give the verifier its own path, outside the checkout and separate from the retained candidate.
    stageArtifactPayload(directory, data, scratch);
    await runRecipe(root, row, "verify", scratch, toolchain, data.inputs, data.sha256);
    if (artifactSourceRevision(root) !== revision) throw new StateConflict("Artifact verification source changed");
    if (verifierKey(root, row) !== verifier)
      throw new StateConflict("Artifact verifier inputs changed during verification");
    if (preparedInputArchive(row) && inputKey(root, row, toolchain) !== data.inputs)
      throw new StateConflict("Prepared profile inputs changed during verification");
    validatePayload(scratch, data);
    validatePayload(directory, data);
    const verified = {
      ...data,
      verification: {
        platform: row.platform,
        sha256: data.sha256,
        time: new Date().toISOString(),
        verifier,
        revision,
      },
    };
    manifestOutput(directory, verified);
    return verified;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface FileArtifact {
  generation: string;
  directory: string;
  manifest: FileArtifactManifest;
}

export interface FileArtifactState {
  state: "verified" | "unverified" | "outdated" | "missing" | "unavailable";
  artifact?: FileArtifact;
  measuredAt?: string;
  modifiedAt?: string;
  generationChoices?: string[];
  detail?: string;
}

function observeArtifactInputs(root: string) {
  let head: string | undefined;
  let revision: string | null | undefined;
  const currentHead = () => {
    head ??= gitRevision(root, "HEAD") ?? "";
    return head;
  };
  const observed = new Map<string, ReturnType<typeof sourceFiles>>();
  const files = (names: readonly string[]) => {
    const paths = [...new Set(names)].sort();
    const key = JSON.stringify(paths);
    let contents = observed.get(key);
    if (!contents) {
      contents = sourceFiles(root, paths, currentHead() !== "");
      observed.set(key, contents);
    }
    return contents;
  };
  return {
    inputs(row: ArtifactPlanEntry, toolchain?: string) {
      if (row.kind === "release" && revision === undefined)
        revision = currentHead() ? artifactSourceRevision(root, head) : null;
      return inputKey(root, row, toolchain, revision ?? null, files);
    },
    verifier(row: ArtifactPlanEntry) {
      return verifierKey(root, row, files);
    },
  };
}

/** Read owned manifests once; verification retains responsibility for hashing the payload. */
export function inspectFileArtifactStates(
  root: string,
  rows: readonly ArtifactPlanEntry[],
  toolchain?: string,
): Map<ArtifactPlanEntry, FileArtifactState> {
  const states = new Map<ArtifactPlanEntry, FileArtifactState>();
  if (!rows.length) return states;
  const recipes = new Map<string, ArtifactPlanEntry[]>();
  for (const row of rows) {
    try {
      const key = recipeKey(row, toolchain);
      const configured = recipes.get(key) ?? [];
      configured.push(row);
      recipes.set(key, configured);
      states.set(row, { state: "missing" });
    } catch (error) {
      states.set(row, { state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const parent = resolve(cachePath(root, "overview"), "..");
  let names: string[];
  try {
    names = readdirSync(parent).filter((entry) => digestPattern.test(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      for (const row of rows)
        states.set(row, { state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
    return states;
  }
  const preference = { unavailable: 0, missing: 1, outdated: 2, unverified: 3, verified: 4 };
  const inputsByRecipe = new Map<string, string | null>();
  const observed = observeArtifactInputs(root);
  const current = new Map<string, Map<string, FileArtifactState>>();
  const measuredAt = new Date().toISOString();
  for (const name of names.sort()) {
    try {
      const directory = ownedPath(parent, name);
      const data = manifestValue(manifestBytes(directory));
      const matches = typeof data.recipe === "string" ? recipes.get(data.recipe) : undefined;
      const first = matches?.[0];
      if (!matches || !first) continue;
      const manifest = decodeManifest(data, first, toolchain);
      if (manifest.inputs !== name && transferGeneration(manifest) !== name) continue;
      const payload = lstatSync(ownedPath(directory, manifest.file));
      if (!payload.isFile() || payload.size !== manifest.bytes) continue;
      if (manifest.verification && manifest.verification.verifier !== observed.verifier(first))
        delete manifest.verification;
      let inputs = inputsByRecipe.get(manifest.recipe);
      if (inputs === undefined) {
        try {
          inputs = observed.inputs(first, toolchain);
          inputsByRecipe.set(manifest.recipe, inputs);
        } catch (error) {
          inputsByRecipe.set(manifest.recipe, null);
          for (const row of matches)
            states.set(row, { state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      if (inputs === null) continue;
      const state = manifest.inputs !== inputs ? "outdated" : manifest.verification ? "verified" : "unverified";
      const modifiedAt = payload.mtime.toISOString();
      const result: FileArtifactState = {
        state,
        artifact: { generation: name, directory, manifest },
        measuredAt,
        modifiedAt,
      };
      if (state === "outdated") {
        for (const row of matches) {
          const previous = states.get(row);
          if (
            !previous ||
            preference[state] > preference[previous.state] ||
            (state === previous.state && modifiedAt > (previous.modifiedAt ?? ""))
          )
            states.set(row, result);
        }
        continue;
      }
      const choices = current.get(manifest.recipe) ?? new Map<string, FileArtifactState>();
      const prior = choices.get(manifest.sha256);
      const exactSource = typeof manifest.verification?.revision === "string";
      const priorExactSource = typeof prior?.artifact?.manifest.verification?.revision === "string";
      if (
        !prior ||
        preference[state] > preference[prior.state] ||
        (state === prior.state &&
          ((exactSource && !priorExactSource) ||
            (exactSource === priorExactSource && modifiedAt > (prior.modifiedAt ?? ""))))
      )
        choices.set(manifest.sha256, result);
      current.set(manifest.recipe, choices);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // A damaged or unrelated entry supplies no positive readiness evidence.
    }
  }
  for (const [recipe, candidates] of current) {
    const values = [...candidates.values()];
    const verified = values.filter((candidate) => candidate.state === "verified");
    const choices = verified.length ? verified : values;
    const first = required(choices[0], "Expected a current artifact");
    const result =
      choices.length === 1
        ? first
        : {
            state: first.state,
            generationChoices: choices
              .map(({ artifact }) => required(artifact, "Expected a current generation").generation)
              .sort(),
            detail: "Several current artifacts match this recipe. Select a generation explicitly.",
          };
    for (const row of recipes.get(recipe) ?? []) states.set(row, result);
  }
  return states;
}

/** Resolve the same exact retained outputs shown by the inventory. */
export function selectFileArtifacts(root: string, rows: readonly ArtifactPlanEntry[], toolchain?: string) {
  const states = inspectFileArtifactStates(root, rows, toolchain);
  return rows.map((row) => {
    const state = states.get(row);
    if (state?.generationChoices)
      throw new InvalidInput(
        `${row.profile}: several artifacts match current inputs. Select --generation from:\n${state.generationChoices.join("\n")}`,
      );
    if (state?.state === "unavailable") throw new InvalidInput(state.detail ?? "Artifact inventory is unavailable");
    return {
      row,
      artifact: state?.state === "verified" || state?.state === "unverified" ? state.artifact : undefined,
    };
  });
}

function transferGeneration({ recipe, inputs, revision, sha256 }: FileArtifactManifest): string {
  return imageHash(JSON.stringify(["transfer", recipe, inputs, revision, sha256]));
}

export async function stagePublishedFileArtifact(artifact: FileArtifact, destination: string): Promise<void> {
  if (!artifact.manifest.verification) throw new InvalidInput("Verify the selected artifact before publication");
  await withCacheLock(
    artifact.directory,
    async () => {
      const file = validatePayload(artifact.directory, artifact.manifest);
      await copyFile(file, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    },
    undefined,
    undefined,
    { mutable: false },
  );
}

export function inspectFileArtifact(
  root: string,
  row: ArtifactPlanEntry,
  toolchain?: string,
  selectedGeneration?: string,
): FileArtifact | undefined {
  if (selectedGeneration === undefined) return selectFileArtifacts(root, [row], toolchain)[0]?.artifact;
  const generation = digest(selectedGeneration, "generation");
  const directory = cachePath(root, generation);
  if (!existsSync(directory)) return undefined;
  const manifest = readManifest(directory, row, toolchain);
  if (manifest.inputs !== generation && transferGeneration(manifest) !== generation)
    throw new StateConflict("Artifact cache belongs to a different generation");
  discardStaleVerification(root, manifest, row);
  return { generation, directory, manifest };
}

/** Match selected retained bytes to the current catalog without computing other targets' build inputs. */
export function inspectFileArtifactGenerations(
  root: string,
  rows: readonly ArtifactPlanEntry[],
  generations: readonly string[],
  toolchain?: string,
): { row: ArtifactPlanEntry; artifact: FileArtifact }[] {
  if (new Set(generations).size !== generations.length) throw new InvalidInput("Select distinct artifact generations");
  const recipes = new Map(rows.map((row) => [recipeKey(row, toolchain), row]));
  const matched = generations.map((id) => {
    const generation = digest(id, "generation");
    const directory = cachePath(root, generation);
    if (!existsSync(directory)) throw new InvalidInput(`Artifact generation ${generation} is unavailable`);
    const value = manifestValue(manifestBytes(directory));
    const row = recipes.get(digest(value.recipe, "recipe"));
    if (!row) throw new InvalidInput(`Artifact generation ${generation} does not match a selected release recipe`);
    const manifest = decodeManifest(value, row, toolchain);
    if (manifest.inputs !== generation && transferGeneration(manifest) !== generation)
      throw new StateConflict("Artifact cache belongs to a different generation");
    discardStaleVerification(root, manifest, row);
    return { row, artifact: { generation, directory, manifest } };
  });
  const profiles = new Set(matched.map(({ row }) => row.profile));
  for (const { profile } of rows)
    if (!profiles.has(profile)) throw new InvalidInput(`${profile}: select a release generation for this profile`);
  return matched;
}

export async function verifyFileArtifact(
  root: string,
  row: ArtifactPlanEntry,
  toolchain?: string,
  generation?: string,
): Promise<FileArtifact> {
  requireLocalHost(row);
  const existing = inspectFileArtifact(root, row, toolchain, generation);
  if (!existing)
    throw new InvalidInput(
      generation ? "This artifact generation is unavailable" : "Build or import an artifact first",
    );
  return withCacheLock(existing.directory, async () => {
    const selected = inspectFileArtifact(root, row, toolchain, existing.generation);
    if (!selected) throw new StateConflict("Artifact was removed before verification");
    const result = {
      ...selected,
      manifest: await verifyPayload(root, row, selected.directory, selected.manifest, toolchain),
    };
    await maintainFileArtifactCache(root, row, result, toolchain);
    return result;
  });
}

/** Keep the selected generation in use while its verified inputs supply the local session. */
export async function useDevelopmentArchive(
  root: string,
  row: ArtifactPlanEntry,
  command: string[],
  options: { path?: string; generation?: string; toolchain?: string },
): Promise<number> {
  requireLocalHost(row);
  const recipe = row.definition;
  const native = "nativeProfile" in recipe ? nativeSelection(root, row, recipe) : undefined;
  const managed =
    "storeProfile" in recipe && recipe.bootstrapImage
      ? { ...storeSelection(root, row, recipe), bootstrap: recipe.bootstrapImage }
      : undefined;
  const profile = native?.profile ?? managed?.profile;
  if (!profile) throw new InvalidInput("Select a native archive or a managed export with a pinned bootstrap");
  const roots = profile.offline.paths ?? readLanguageRoots(root).map(({ path }) => path);
  const path = options.path ?? (roots.length === 1 ? roots[0] : roots.includes(".") ? "." : undefined);
  if (path === undefined || !roots.includes(path))
    throw new InvalidInput(`Select a language root covered by this archive with --path (${roots.join(", ")})`);
  const { generation: requested, toolchain } = options;
  const selected = inspectFileArtifact(root, row, toolchain, requested);
  if (!selected) throw new InvalidInput("Build or import the selected archive before using it");
  const cancellation = processCancellation();
  try {
    return await withCacheLock(
      selected.directory,
      async () => {
        const artifact = inspectFileArtifact(root, row, toolchain, selected.generation);
        if (!artifact) throw new StateConflict("The selected archive is no longer available");
        if (artifact.manifest.inputs !== inputKey(root, row, toolchain))
          throw new StateConflict("The archive does not match the current profile inputs");
        if (!artifact.manifest.verification) throw new InvalidInput("Verify the selected archive before using it");
        if (managed) {
          const scratch = mkdtempSync(join(artifact.directory, ".store-shell-"));
          try {
            const file = stageArtifactPayload(artifact.directory, artifact.manifest, scratch);
            if (artifact.manifest.inputs !== inputKey(root, row, toolchain))
              throw new StateConflict("The project profile changed during archive activation");
            cancellation.signal.throwIfAborted();
            return await openStoreArchiveShell(
              root,
              profile,
              managed.bootstrap,
              { file, expected: managed.expected },
              path,
              command,
              cancellation.signal,
            );
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        }
        const kind = required(native, "Expected a native archive selection").kind;
        const cache = ownedPath(artifact.directory, "native-workspace");
        const seedReceipt = join(cache, ".workbench-archive-seed");
        if (!existsSync(cache)) {
          await withCacheInstallation(cache, false, async (stage) => {
            // Stage a private copy so the bytes authenticated here are the bytes restored below.
            const archive = stageArtifactPayload(artifact.directory, artifact.manifest, stage);
            const seed = join(stage, "cache");
            await restoreNativeArchive(archive, seed, kind);
            cancellation.signal.throwIfAborted();
            writeAtomic(join(seed, ".workbench-archive-seed"), artifact.manifest.sha256);
            renameSync(seed, cache);
          });
        }
        if (
          !existsSync(seedReceipt) ||
          readBoundedFile(seedReceipt, 64, "native archive seed").toString() !== artifact.manifest.sha256
        )
          throw new StateConflict(
            "The native archive workspace does not match its verified seed; rebuild or reimport in a fresh cache",
          );
        const distribution = distributionRoot(root);
        const launcher = join(distribution, "bin/workbench.mjs");
        const env = {
          ...process.env,
          ...ciCacheEnvironment(cache, userDirectory("data"), true),
          XDG_CACHE_HOME: join(cache, "xdg"),
          PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter),
          WORKBENCH_PROJECT_ROOT: root,
          WORKBENCH_TOOLCHAIN: profile.toolchain ?? "",
          WORKBENCH_TOOLCHAIN_ROOT: root,
          WORKBENCH_OFFLINE: "1",
        };
        const args = ["--path", path, ...(profile.toolchain ? ["--toolchain", profile.toolchain] : [])];
        const invocation = { cwd: root, env, signal: cancellation.signal, inheritOutput: true, inheritInput: true };
        const install = await runOwnedChild(
          process.execPath,
          [launcher, "tools", "install", ...args, "--exclude-tool", "miri"],
          invocation,
        );
        const failure = processFailure("Install tools from the archive", install);
        if (failure) throw failure;
        if (artifact.manifest.inputs !== inputKey(root, row, toolchain))
          throw new StateConflict("The project profile changed during archive activation");
        const session = await runOwnedChild(
          process.execPath,
          [launcher, "shell", "--environment", "native", ...args, "--", ...command],
          invocation,
        );
        if (session.error || session.signal !== null || session.status === null)
          throw processFailure("Run archive shell", session) ?? new Error("Archive shell returned no exit status");
        return session.status;
      },
      undefined,
      cancellation.signal,
    );
  } finally {
    cancellation.close();
  }
}

/** Retire only older local builds of a verified replacement. Transfers may carry unique target evidence. */
async function maintainFileArtifactCache(
  root: string,
  row: ArtifactPlanEntry,
  replacement: FileArtifact,
  toolchain?: string,
): Promise<void> {
  if (!replacement.manifest.verification) return;
  if (replacement.generation !== replacement.manifest.inputs) return;
  try {
    const settings = userConfigValues();
    const maximum = settings["cache.max_generations"] as number;
    const ageDays = settings["cache.max_age_days"] as number;
    if (!settings["cache.auto_prune"] || (!maximum && !ageDays)) return;
    const expiry = Date.now() - ageDays * 86_400_000;
    const newer = Date.parse(replacement.manifest.verification.time);
    const inspect = (directory: string) => {
      const manifest = readManifest(directory, row, toolchain);
      if (
        basename(directory) !== manifest.inputs ||
        !manifest.verification ||
        Date.parse(manifest.verification.time) >= newer ||
        readdirSync(directory).some(
          (name) => ![manifestName, manifest.file, cacheSizeMarker, cacheGenerationMarker].includes(name),
        )
      )
        return;
      return manifest;
    };
    const parent = dirname(replacement.directory);
    for (const operation of inspectCacheOperations(parent))
      if (operation.action === "delete" && operation.state === "pending") await recoverCacheOperation(operation);
    const candidates = readdirSync(parent).flatMap((generation) => {
      if (!digestPattern.test(generation) || generation === replacement.generation) return [];
      try {
        const directory = ownedPath(parent, generation);
        const manifest = inspect(directory);
        return manifest?.verification ? [{ directory, time: Date.parse(manifest.verification.time) }] : [];
      } catch {
        return []; // Unrecognized ownership supplies no removal authority.
      }
    });
    candidates.sort((a, b) => b.time - a.time || a.directory.localeCompare(b.directory));
    const selected = candidates.filter(
      ({ time }, index) => (maximum > 0 && index >= maximum - 1) || (ageDays > 0 && time <= expiry),
    );
    if (!selected.length || inputKey(root, row, toolchain) !== replacement.manifest.inputs) return;
    for (const { directory } of selected) {
      if (inspectCacheMetadataLock(directory).state !== CacheLockState.Unlocked) continue;
      try {
        await withCacheLock(
          directory,
          async () => {
            if (keptCacheAssets().has(directory)) return;
            const manifest = inspect(directory);
            if (!manifest) return;
            validatePayload(directory, manifest);
            await removeOwnedCache(directory);
          },
          0,
        );
      } catch (error) {
        if (!(error instanceof CacheBusy)) throw error;
      }
    }
  } catch (error) {
    try {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Failed,
        { command: "artifact cache maintenance" },
        error,
        "verified artifact retained; older artifacts could not be pruned",
      );
    } catch {
      // Optional maintenance cannot invalidate the verified replacement.
    }
  }
}

export async function buildFileArtifact(
  root: string,
  row: ArtifactPlanEntry,
  toolchain?: string,
  beforeVerification = false,
): Promise<FileArtifact> {
  requireLocalHost(row);
  if (row.workspace !== "host") throw new InvalidInput(`${row.profile}: file recipes require a host workspace`);
  artifactFileName(row);
  const revision = artifactSourceRevision(root);
  const inputs = inputKey(root, row, toolchain, revision);
  const directory = cachePath(root, inputs);
  mkdirSync(resolve(directory, ".."), { recursive: true, mode: 0o700 });
  return withCacheLock(directory, async () => {
    if (existsSync(directory)) {
      const manifest = readManifest(directory, row, toolchain);
      if (manifest.inputs !== inputs) throw new StateConflict("Artifact cache belongs to a different input generation");
      validatePayload(directory, manifest);
      discardStaleVerification(root, manifest, row);
      const needsVerification =
        preparedInputArchive(row) ||
        !manifest.verification ||
        (row.kind === "release" && manifest.verification.revision !== revision);
      const result = {
        generation: inputs,
        directory,
        manifest:
          !beforeVerification && needsVerification
            ? await verifyPayload(root, row, directory, manifest, toolchain)
            : manifest,
      };
      if (!beforeVerification) await maintainFileArtifactCache(root, row, result, toolchain);
      return result;
    }
    let manifest: FileArtifactManifest | undefined;
    await withCacheInstallation(directory, true, async (stage) => {
      await runRecipe(root, row, "build", stage, toolchain);
      if (inputKey(root, row, toolchain) !== inputs)
        throw new StateConflict("Artifact inputs changed during the build");
      manifest = payloadManifest(stage, row, inputs, revision, toolchain);
      if (!beforeVerification) manifest = await verifyPayload(root, row, stage, manifest, toolchain);
      else manifestOutput(stage, manifest);
      renameSync(stage, directory);
    });
    if (!manifest) throw new Error("Artifact preparation did not retain a manifest");
    const result = { generation: inputs, directory, manifest };
    await maintainFileArtifactCache(root, row, result, toolchain);
    return result;
  });
}

export async function exportFileArtifact(artifact: FileArtifact, destination: string, unverified = false) {
  if (!artifact.manifest.verification && !unverified)
    throw new InvalidInput("Verify the artifact before export or explicitly opt in to unverified transfer");
  const checkDestination = (path: string) => {
    const fromCache = relative(dirname(artifact.directory), path);
    if (!isAbsolute(fromCache) && fromCache !== ".." && !fromCache.startsWith(`..${sep}`))
      throw new InvalidInput("Export to a directory outside the artifact cache");
  };
  checkDestination(resolve(destination));
  mkdirSync(destination, { recursive: true });
  const parent = realpathSync(destination);
  checkDestination(parent);
  const contents = Buffer.from(encodeManifest(artifact.manifest));
  const checksum = createHash("sha256").update(contents).digest("hex");
  const directory = ownedPath(parent, `artifact-${checksum}`);
  const delivery = { directory, manifestSha256: checksum };
  return withCacheLock(
    artifact.directory,
    async () =>
      withCacheLock(
        directory,
        async () => {
          if (existsSync(directory)) {
            if (!manifestBytes(directory).equals(contents))
              throw new StateConflict(`Artifact export has a different manifest: ${directory}`);
            validatePayload(directory, artifact.manifest);
            return delivery;
          }
          const stage = mkdtempSync(join(parent, ".artifact-export-"));
          try {
            const file = ownedPath(artifact.directory, artifact.manifest.file);
            await copyFile(
              file,
              join(stage, artifact.manifest.file),
              constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
            );
            validatePayload(stage, artifact.manifest);
            writeAtomic(join(stage, manifestName), contents);
            renameSync(stage, directory);
            return delivery;
          } finally {
            rmSync(stage, { recursive: true, force: true });
          }
        },
        undefined,
        undefined,
        { mutable: false },
      ),
    undefined,
    undefined,
    { mutable: false },
  );
}

export async function importFileArtifact(
  root: string,
  row: ArtifactPlanEntry,
  source: string,
  expected: string,
  options: { toolchain?: string; verifiedOnTarget?: boolean } = {},
) {
  const { toolchain, verifiedOnTarget = false } = options;
  if (!verifiedOnTarget) requireLocalHost(row);
  digest(expected, "manifest SHA-256");
  const from = realpathSync(source);
  const contents = manifestBytes(from);
  if (createHash("sha256").update(contents).digest("hex") !== expected)
    throw new StateConflict("Artifact manifest does not match the supplied SHA-256");
  const manifest = decodeManifest(manifestValue(contents), row, toolchain);
  if (preparedInputArchive(row) && inputKey(root, row, toolchain) !== manifest.inputs)
    throw new StateConflict("Prepared artifact does not match the receiving project profile inputs");
  const revision = verifiedOnTarget ? artifactSourceRevision(root) : undefined;
  const proof = manifest.verification;
  if (
    verifiedOnTarget &&
    (row.kind !== "release" ||
      !revision ||
      manifest.revision !== revision ||
      proof?.revision !== revision ||
      proof.verifier !== verifierKey(root, row))
  )
    throw new StateConflict(
      "A verified release transfer requires target verification from this exact clean source revision",
    );
  const retainVerification = async (directory: string, candidate: FileArtifactManifest) => {
    if (!verifiedOnTarget || !proof) return verifyPayload(root, row, directory, candidate, toolchain);
    validatePayload(directory, candidate);
    if (artifactSourceRevision(root) !== revision) throw new StateConflict("Artifact import source changed");
    const verified: FileArtifactManifest = { ...candidate, verification: { ...proof, source: "transfer" } };
    manifestOutput(directory, verified);
    return verified;
  };
  validatePayload(from, manifest);
  const generation = transferGeneration(manifest);
  const directory = cachePath(root, generation);
  mkdirSync(resolve(directory, ".."), { recursive: true, mode: 0o700 });
  return withCacheLock(directory, async () => {
    if (existsSync(directory)) {
      const current = readManifest(directory, row, toolchain);
      if (transferGeneration(current) !== generation || !current.verification)
        throw new StateConflict("Existing artifact import is not verified");
      validatePayload(directory, current);
      return {
        generation,
        directory,
        manifest:
          !preparedInputArchive(row) &&
          current.verification.verifier === verifierKey(root, row) &&
          (verifiedOnTarget || current.verification.source !== "transfer") &&
          (row.kind !== "release" || current.verification.revision === (revision ?? artifactSourceRevision(root)))
            ? current
            : await retainVerification(directory, current),
      };
    }
    let verified: FileArtifactManifest | undefined;
    await withCacheInstallation(directory, true, async (stage) => {
      const target = join(stage, manifest.file);
      copyFileSync(join(from, manifest.file), target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      verified = await retainVerification(stage, manifest);
      renameSync(stage, directory);
    });
    if (!verified) throw new Error("Artifact import did not retain verification");
    return { generation, directory, manifest: verified };
  });
}
