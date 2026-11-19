import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { combineFailures, settleCleanup } from "../diagnostics/diagnostic-errors.mjs";
import { hashFile, readBoundedFile } from "../runtime/file-reads.js";
import { publishCheckedFiles, writeNew, type CheckedFile } from "../runtime/file-publication.mjs";
import { captureOwnedChild, processCancellation } from "../runtime/owned-child.mjs";
import { createOwnedScratch } from "../runtime/owned-scratch.mjs";
import { ownedPath } from "../runtime/paths.js";
import { withCacheLock } from "../storage/cache-lock.js";
import { archiveInstallationEnvironment, readDistributionSource } from "./distribution-identity.js";
import { readExecutableIdentity } from "./executable-identity.js";
import { stageReleaseArchive } from "./release-archive.js";
import { sameToolPin, type ToolPin } from "../toolchains/tool-pin.js";
import { artifactLimits } from "../toolchains/acquisition/artifact-streams.js";
import {
  archiveDigest,
  releaseTransitionFile,
  maximumTransitionBytes,
  finishReleaseTransition,
  parseReleaseSelection,
  publishReleaseState,
  readReleaseTransition,
  recordReleaseTransition,
  recoverReleaseLock,
  validArchiveDigest,
  type ReleaseSelection,
  type ReleaseServiceRegistration,
} from "./release-transition.js";

const storageName = ".workbench-installation";
const selectionFile = "active.json";
const installedReleaseFile = "release.json";
const launcherName = process.platform === "win32" ? "workbench.cjs" : "workbench";
const launcherHeader = "#!/usr/bin/env node\n// Workbench archive launcher.\n";
const shimHeader = "@rem Workbench archive launcher\r\n";

function activeRelease(installation: string): { selection: ReleaseSelection; bytes: Buffer } | undefined {
  try {
    const bytes = readBoundedFile(ownedPath(installation, selectionFile), 4096, "active Workbench release");
    return { selection: parseReleaseSelection(bytes.toString()), bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function archiveInstallation(): string | undefined {
  const installation = process.env[archiveInstallationEnvironment];
  if (installation && (!isAbsolute(installation) || basename(installation) !== storageName))
    throw new Error("Invalid Workbench installation location");
  return installation;
}

function launcherPath(installation: string): string {
  return ownedPath(dirname(installation), launcherName);
}

function installedDirectory(installation: string, sha256: string): string {
  return ownedPath(installation, `releases/${sha256}`);
}

/** Resolve the entry point outside the payload for managed service registration. */
export function installedServiceLauncher(distribution: string): string {
  const installation = archiveInstallation();
  if (!installation) return join(distribution, "bin/workbench.mjs");
  const sha256 = activeRelease(installation)?.selection.sha256;
  if (!sha256 || realpathSync(installedDirectory(installation, sha256)) !== realpathSync(distribution))
    throw new Error("Run the active installed Workbench release to register its service");
  return launcherPath(installation);
}

/** Close admission to a new manual listener while the installed release is changing. */
export function checkInstalledServiceStart(distribution: string, managed: boolean): void {
  const installation = process.env[archiveInstallationEnvironment];
  if (!installation) return;
  installedServiceLauncher(distribution);
  if (!managed && lstatSync(`${installation}.lock`, { throwIfNoEntry: false }))
    throw new Error("A Workbench release change is in progress. Wait for it to finish before starting the server.");
}

function launcherText(): string {
  return `${launcherHeader}async function launch() {
  const {lstatSync, readFileSync, realpathSync} = await import("node:fs");
  const {dirname, join} = await import("node:path");
  const {pathToFileURL} = await import("node:url");
  const installation = join(dirname(realpathSync(process.argv[1])), ${JSON.stringify(storageName)});
  const [command, ...args] = process.argv.slice(2);
  const recover = command === "update" && args.includes("--recover");
  const managed = command === "serve" && args.includes("--service") && (
    process.platform === "linux" && process.env.WORKBENCH_SYSTEMD_SERVICE === "1" && !!process.env.NOTIFY_SOCKET
  );
  const privileged = process.geteuid?.() === 0 && (recover || process.env.WORKBENCH_SYSTEM_SERVICE === "1");
  const trusted = (path) => {
    if (!privileged) return;
    for (let current = path; ; current = dirname(current)) {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022)) {
        throw new Error(current + ": system release paths require protected administrator ownership");
      }
      if (dirname(current) === current) return;
    }
  };
  const selection = join(installation, ${JSON.stringify(selectionFile)});
  trusted(selection);
  const receipt = join(installation, ${JSON.stringify(releaseTransitionFile)});
  const pending = lstatSync(receipt, {throwIfNoEntry: false});
  if (pending && !recover && !managed) {
    console.error("workbench: A Workbench update is pending. If the update stopped, run 'workbench update --recover'.");
    process.exitCode = 1;
    return;
  }
  let contents = readFileSync(selection, "utf8");
  if (pending && recover) {
    trusted(receipt);
    if (!pending.isFile() || pending.size > ${String(maximumTransitionBytes)}) {
      throw new Error("Invalid Workbench release update receipt");
    }
    const journal = JSON.parse(readFileSync(receipt, "utf8"));
    if (journal.version !== 1 || typeof journal.before !== "string") throw new Error("Invalid release update receipt");
    contents = journal.before;
  }
  const active = JSON.parse(contents);
  if (active.version !== 1 || typeof active.sha256 !== "string" || !/${archiveDigest.source}/.test(active.sha256)) {
    throw new Error("Invalid active Workbench release");
  }
  process.env[${JSON.stringify(archiveInstallationEnvironment)}] = installation;
  const release = join(installation, "releases", active.sha256);
  const entry = join(release, "bin", "workbench.mjs");
  trusted(entry);
  trusted(join(release, "bundle", "launcher.cjs"));
  trusted(join(release, "bundle", "main.cjs"));
  process.argv[1] = entry;
  await import(pathToFileURL(entry).href);
}
launch().catch((error) => {
  console.error("workbench: " + error.message + "\\nUse the external installer to repair this installation.");
  process.exitCode = 1;
});
`;
}

function ensureInstallationDirectory(path: string): void {
  // The owner controls the payload. System installations may be read and executed by other accounts.
  if (mkdirSync(path, { recursive: true, mode: 0o755 }) && process.platform !== "win32") chmodSync(path, 0o755);
}

function installationEntry(
  path: string,
  contents: string,
  header: string,
  mode: number,
  repair: boolean,
): CheckedFile | undefined {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return { path, contents, mode, expected: undefined };
  if (!entry.isFile() || entry.nlink !== 1) throw new Error(`${path}: preserving the existing installation entry`);
  const expected = readBoundedFile(path, 16 * 1024, "Workbench installation entry");
  const current = expected.toString();
  if (current === contents && (!repair || process.platform === "win32" || (entry.mode & 0o777) === mode))
    return undefined;
  if (
    !repair ||
    !current.startsWith(header) ||
    (process.platform !== "win32" && (entry.uid !== process.geteuid?.() || entry.mode & 0o022))
  )
    throw new Error(`${path}: preserving the existing installation entry`);
  return { path, contents, mode, expected };
}

function preserveDamagedEntry(installation: string, file: CheckedFile): void {
  if (!file.expected || Buffer.from(file.contents).equals(file.expected)) return;
  const directory = ownedPath(installation, "repair");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(file.expected).digest("hex");
  const backup = ownedPath(directory, `${basename(file.path)}-${digest}`);
  if (!lstatSync(backup, { throwIfNoEntry: false })) writeNew(backup, file.expected, 0o600);
  else if (!readBoundedFile(backup, 16 * 1024, "preserved Workbench launcher").equals(file.expected))
    throw new Error(`${backup}: preserving an unexpected repair backup`);
}

function releaseFingerprint(directory: string): string {
  const fingerprint = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  function visit(parent: string, prefix: string): void {
    for (const name of readdirSync(parent).sort()) {
      if (!prefix && name === installedReleaseFile) continue;
      if (++entries > artifactLimits.entries) throw new Error("Installed Workbench release has too many entries");
      const path = join(parent, name);
      const relative = prefix + name;
      const entry = lstatSync(path);
      if (entry.isDirectory()) {
        fingerprint.update(JSON.stringify([relative, entry.mode]));
        visit(path, relative + "/");
      } else if (entry.isFile()) {
        bytes += entry.size;
        if (bytes > artifactLimits.retained) throw new Error("Installed Workbench release exceeds its size limit");
        fingerprint.update(JSON.stringify([relative, entry.mode, hashFile(path, artifactLimits.file, "release file")]));
      } else if (entry.isSymbolicLink()) {
        fingerprint.update(JSON.stringify([relative, entry.mode, readlinkSync(path)]));
      } else throw new Error(relative + ": unexpected entry in the installed Workbench release");
    }
  }
  visit(directory, "");
  return fingerprint.digest("hex");
}

function executableSource(directory: string): ToolPin {
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(directory + ": missing or unrecognized release directory");
  const expected = readDistributionSource(directory);
  if (!expected) throw new Error("Installation requires a release archive with an immutable source identity");
  return expected;
}

function releaseReceipt(directory: string, sha256: string, source: ToolPin): string {
  return JSON.stringify({ version: 1, sha256, source, fingerprint: releaseFingerprint(directory) }) + "\n";
}

async function verifyExecutable(
  directory: string,
  expected: ToolPin,
  scratch: ReturnType<typeof createOwnedScratch>,
  signal: AbortSignal,
): Promise<void> {
  const result = await captureOwnedChild(
    process.execPath,
    [ownedPath(directory, "bin/workbench.mjs"), "executable", "--json"],
    {
      cwd: scratch.directory,
      signal,
      owner: scratch.owner,
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        WORKBENCH_PROJECT_ROOT: scratch.directory,
        WORKBENCH_EXECUTING_SPEC: undefined,
        WORKBENCH_LAUNCH_CHAIN: undefined,
        [archiveInstallationEnvironment]: undefined,
      },
    },
    16 * 1024,
  );
  if (result.error || result.status !== 0)
    throw new Error(`Workbench release startup failed: ${result.error?.message ?? result.stderr}`, {
      cause: result.error,
    });
  const identity = readExecutableIdentity(JSON.parse(result.stdout));
  if (
    !identity.repository ||
    !identity.revision ||
    !sameToolPin(expected, { repository: identity.repository, revision: identity.revision })
  )
    throw new Error("Workbench release reported a different source identity");
  signal.throwIfAborted();
}

interface ReleaseArchive {
  source: string;
  sha256: string;
}

export interface ReleaseActivation {
  launcher: string;
  previous: string;
  replacement: string;
  begin: (service: ReleaseServiceRegistration) => void;
  select: () => void;
  restore: () => void;
  finishRestoration: () => void;
}

async function prepareRelease(installation: string, sha256: string, source?: string): Promise<ToolPin> {
  const releases = ownedPath(installation, "releases");
  ensureInstallationDirectory(releases);
  const target = installedDirectory(installation, sha256);
  const scratch = createOwnedScratch(releases, "candidate");
  const cancellation = processCancellation();
  let failure: unknown;
  try {
    const candidate = source ? (await stageReleaseArchive(source, sha256, scratch.directory)).directory : undefined;
    const expected = executableSource(candidate ?? target);
    const receipt = releaseReceipt(candidate ?? target, sha256, expected);
    if (lstatSync(target, { throwIfNoEntry: false })) {
      const retained = candidate ? releaseReceipt(target, sha256, executableSource(target)) : receipt;
      if (
        retained !== receipt ||
        readBoundedFile(ownedPath(target, installedReleaseFile), 4096, "installed release receipt").toString() !==
          retained
      )
        throw new Error(`${target}: installed release contents differ from their verified receipt`);
      await verifyExecutable(target, expected, scratch, cancellation.signal);
    } else {
      if (!candidate) throw new Error("The previous Workbench release is unavailable");
      await verifyExecutable(candidate, expected, scratch, cancellation.signal);
      writeNew(ownedPath(candidate, installedReleaseFile), receipt, 0o644);
      chmodSync(candidate, 0o755);
      renameSync(candidate, target);
    }
    return expected;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await settleCleanup([scratch.release, cancellation.close], failure);
  }
}

/** Prepare a complete release before a stable CLI entry can select it. */
export async function installArchiveRelease(
  directory: string,
  source: string,
  sha256: string,
  repair = false,
): Promise<string> {
  const installation = ownedPath(directory, storageName);
  const launcher = ownedPath(directory, launcherName);
  const shim = process.platform === "win32" ? ownedPath(directory, "workbench.cmd") : undefined;
  const shimContents = shimHeader + '@node "%~dp0workbench.cjs" %*\r\n';
  if (!archiveDigest.test(sha256)) throw new Error("A Workbench release requires its expected SHA-256 checksum");
  if (repair) {
    if (!activeRelease(installation)) throw new Error("No archive-managed Workbench installation to repair");
    recoverReleaseLock(installation);
  } else ensureInstallationDirectory(directory);
  return withCacheLock(installation, async () => {
    const pending = readReleaseTransition(ownedPath(installation, releaseTransitionFile));
    if (pending && !repair)
      throw new Error("Use 'workbench update --recover' to finish recovering the installed release.");
    const current = activeRelease(installation);
    if (repair) {
      if (!current) throw new Error("No archive-managed Workbench installation to repair");
      if (pending && current.bytes.toString() !== pending.before && current.bytes.toString() !== pending.after)
        throw new Error("The active Workbench release changed independently. Preserve the update receipt.");
      const expected = pending ? parseReleaseSelection(pending.before).sha256 : current.selection.sha256;
      if (expected !== sha256)
        throw new Error(
          "Repair requires the previous verified archive during recovery or the active archive otherwise.",
        );
    } else if (current && current.selection.sha256 !== sha256) {
      throw new Error("A Workbench release is already active. Use the update workflow.");
    }
    const entries = [
      installationEntry(launcher, launcherText(), launcherHeader, 0o755, repair),
      shim ? installationEntry(shim, shimContents, shimHeader, 0o644, repair) : undefined,
    ].filter((entry) => entry !== undefined);
    ensureInstallationDirectory(installation);
    await prepareRelease(installation, sha256, source);
    if (!current)
      writeNew(ownedPath(installation, selectionFile), JSON.stringify({ version: 1, sha256 }) + "\n", 0o644);
    for (const entry of entries) preserveDamagedEntry(installation, entry);
    publishCheckedFiles(entries);
    return shim ?? launcher;
  });
}

/** Select a verified replacement from the same installation without changing project files. */
export async function updateArchiveRelease(
  distribution: string,
  release: ReleaseArchive | "rollback",
  activate: (transition: ReleaseActivation) => void | Promise<void>,
): Promise<ToolPin> {
  const launcher = installedServiceLauncher(distribution);
  const installation = archiveInstallation();
  if (!installation) throw new Error("Run the installed Workbench command to switch release archives");
  return withCacheLock(installation, async () => {
    const receipt = ownedPath(installation, releaseTransitionFile);
    if (readReleaseTransition(receipt))
      throw new Error("Use 'workbench update --recover' to finish recovering the installed release.");
    const active = activeRelease(installation);
    if (
      !active ||
      realpathSync(installedDirectory(installation, active.selection.sha256)) !== realpathSync(distribution)
    )
      throw new Error("The active Workbench release changed. Run the installed command again.");
    const previous = active.selection.sha256;
    const sha256 = release === "rollback" ? active.selection.previous : release.sha256;
    if (!sha256) throw new Error("No previous Workbench release is available");
    if (!validArchiveDigest(sha256)) throw new Error("A Workbench release requires its expected SHA-256 checksum");
    const candidate = await prepareRelease(installation, sha256, release === "rollback" ? undefined : release.source);
    if (sha256 === previous) return candidate;
    await prepareRelease(installation, previous);
    const path = ownedPath(installation, selectionFile);
    const selected: ReleaseSelection = { version: 1, sha256, previous };
    const before = active.bytes.toString();
    const after = JSON.stringify(selected) + "\n";
    const state = { recorded: false, managed: false };
    const transition = {
      launcher,
      previous: distribution,
      replacement: installedDirectory(installation, sha256),
      begin(service: ReleaseServiceRegistration) {
        recordReleaseTransition(receipt, before, after, service);
        state.recorded = state.managed = true;
      },
      select() {
        if (!state.recorded) {
          recordReleaseTransition(receipt, before, after);
          state.recorded = true;
        }
        publishReleaseState(path, after, active.bytes, 0o644);
      },
      restore() {
        restoreSelection(path, before, after);
      },
      finishRestoration() {
        finishReleaseTransition(receipt);
        state.recorded = false;
      },
    };
    try {
      await activate(transition);
      if (!state.recorded || readBoundedFile(path, 4096, "active Workbench release").toString() !== after)
        throw new Error("The verified Workbench release was not activated");
    } catch (failure) {
      if (state.recorded && !state.managed)
        try {
          transition.restore();
          transition.finishRestoration();
        } catch (restore) {
          throw combineFailures(
            failure,
            restore,
            "Workbench activation failed and could not restore the previous release",
          );
        }
      throw failure;
    }
    finishReleaseTransition(receipt);
    return candidate;
  });
}

function restoreSelection(path: string, before: string, after: string): void {
  const current = readBoundedFile(path, 4096, "active Workbench release");
  const selected = current.toString();
  if (selected === before) return;
  if (selected !== after)
    throw new Error("The active Workbench release changed independently. Preserve the update receipt.");
  publishReleaseState(path, before, current, 0o644);
}

export async function recoverArchiveRelease(
  recover: (
    launcher: string,
    restore: () => void,
    service: ReleaseServiceRegistration | undefined,
    previous: string,
  ) => void | Promise<void>,
): Promise<ToolPin> {
  const installation = archiveInstallation();
  if (!installation) throw new Error("Run the installed Workbench launcher to recover a release update");
  recoverReleaseLock(installation);
  return withCacheLock(installation, async () => {
    const receipt = ownedPath(installation, releaseTransitionFile);
    const pending = readReleaseTransition(receipt);
    const active = activeRelease(installation);
    if (!active) throw new Error("No active Workbench release. Use the external installer to repair it.");
    if (!pending) return prepareRelease(installation, active.selection.sha256);
    const selected = active.bytes.toString();
    if (selected !== pending.before && selected !== pending.after)
      throw new Error("The active Workbench release changed independently. Preserve the update receipt.");
    const previousDigest = parseReleaseSelection(pending.before).sha256;
    const previous = await prepareRelease(installation, previousDigest);
    const path = ownedPath(installation, selectionFile);
    await recover(
      launcherPath(installation),
      () => {
        restoreSelection(path, pending.before, pending.after);
      },
      pending.service,
      installedDirectory(installation, previousDigest),
    );
    if (readBoundedFile(path, 4096, "active Workbench release").toString() !== pending.before)
      throw new Error("The previous Workbench release was not restored");
    finishReleaseTransition(receipt);
    return previous;
  });
}
