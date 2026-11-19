import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { settleCleanup } from "../../core/diagnostics/diagnostic-errors.mjs";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
import { checkInstalledServiceStart } from "../../core/distribution/installed-release.js";
import { launchdServiceProcess } from "../../core/distribution/distribution-identity.js";
import { notifySystemdServiceReady, systemdServiceProcess } from "../../core/distribution/systemd-service.js";
import { processCancellation } from "../../core/runtime/owned-child.mjs";
import { errorFrom, isRecord } from "../../core/runtime/values.mjs";
import {
  CacheBusy,
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "../../core/storage/cache-lock.js";
import { userDirectory } from "../../core/storage/storage.js";
import { startProjectHub } from "../projects/project-hub.js";
import { demonstrationBase } from "../projects/project-mounts.js";
import { localBrowserUsername } from "./browser-auth.js";
import { discoverSystemService, serviceRelease, systemServicePending } from "./system-service.js";
import { activePrivateListenerProcesses, markPrivateListener } from "./system-ownership.js";

type Hub = Awaited<ReturnType<typeof startProjectHub>>;
type Options = NonNullable<Parameters<typeof startProjectHub>[1]> & {
  mode: "foreground" | "daemon" | "service";
  logs: string | undefined;
};
type Access = Pick<Hub, "url" | "signIn"> & { pid: number; logs: string | undefined; shared?: boolean };
type Present = (access: Access, started: boolean) => void;

const maximumReplyBytes = 16 * 1024;
const protocol = 1;

/** Directory traversal and replacement must stay within the account and its OS administrator. */
function trustedDirectory(path: string, uid: number): string {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) {
    const directory = join(trustedDirectory(dirname(path), uid), basename(path));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return trustedDirectory(directory, uid);
  }
  const directory = realpathSync(path);
  const parent = dirname(directory);
  if (parent !== directory) trustedDirectory(parent, uid);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022 && !(stat.mode & 0o1000)))
    throw new Error(`${directory}: Workbench service discovery requires trusted directories with protected ownership`);
  return directory;
}

function validatePrivateDirectory(directory: string, uid: number, info: Stats): void {
  if (!info.isDirectory() || info.uid !== uid || info.mode & 0o077)
    throw new Error(`${directory}: Workbench service discovery requires an account-owned private directory`);
}

function privateDirectory(path: string, uid: number): string {
  const directory = join(trustedDirectory(dirname(path), uid), basename(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  validatePrivateDirectory(directory, uid, lstatSync(directory));
  return directory;
}

function servicePaths(stateHome = userDirectory("state")) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Workbench service discovery requires a local account");
  const state = privateDirectory(join(stateHome, "daemon"), uid);
  const identity = createHash("sha256")
    .update(JSON.stringify([hostname(), state]))
    .digest("hex")
    .slice(0, 32);
  // A short local socket can serve an arbitrarily long state home, including state on a network filesystem.
  const directory = join(trustedDirectory("/tmp", uid), `wb-${String(uid)}-${identity}`);
  return { uid, directory, lease: join(state, `private-${identity}`), socket: join(directory, "serve.sock") };
}

function windowsPrivateLease(): string {
  return join(userDirectory("state"), "daemon", "windows-private");
}

/** A manual server must stop before the application can switch its installed release. */
export function assertReleaseServicesIdle(exceptPid?: number, managedState?: string): void {
  const active =
    process.platform === "linux" || (process.platform === "darwin" && process.geteuid?.() === 0)
      ? activePrivateListenerProcesses(process.geteuid?.() === 0 ? undefined : process.geteuid?.()).some(
          (pid) => pid !== exceptPid,
        )
      : process.platform === "win32"
        ? inspectCacheMetadataLock(windowsPrivateLease()).state !== CacheLockState.Unlocked
        : [...new Set([userDirectory("state"), managedState])].some((directory) => {
            const lock = inspectCacheMetadataLock(servicePaths(directory).lease);
            return (
              lock.state === CacheLockState.Uncertain ||
              (lock.state === CacheLockState.Active && lock.owner.pid !== exceptPid)
            );
          });
  if (active) throw new Error("Stop the manual Workbench server before switching installed releases.");
  if (process.geteuid?.() === 0 && exceptPid === undefined && systemServicePending())
    throw new Error("Stop the unmanaged shared Workbench server before switching installed releases.");
}

function verifySocket(path: string, uid: number): boolean {
  const directory = dirname(path);
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return false;
  validatePrivateDirectory(directory, uid, info);
  const socket = lstatSync(path, { throwIfNoEntry: false });
  if (!socket) return false;
  if (!socket.isSocket() || socket.uid !== uid)
    throw new Error(`${path}: the Workbench service socket owner could not be verified`);
  return true;
}

function decodeAccess(bytes: Buffer, release: string, demo: boolean): Access {
  const invalid = () => new Error("Invalid response from the local Workbench service");
  let reply: unknown;
  try {
    reply = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    // A parser error can contain part of the sign-in credential.
    throw invalid();
  }
  if (!isRecord(reply) || reply.protocol !== protocol || reply.release !== release)
    throw new Error(
      "A different Workbench release owns the local service. Stop that service before starting this release.",
    );
  if (
    (reply.host !== "127.0.0.1" && reply.host !== "[::1]") ||
    typeof reply.port !== "number" ||
    !Number.isInteger(reply.port) ||
    reply.port < 1 ||
    reply.port > 65535 ||
    typeof reply.pid !== "number" ||
    !Number.isSafeInteger(reply.pid) ||
    reply.pid <= 0 ||
    (reply.logs !== undefined && (typeof reply.logs !== "string" || !isAbsolute(reply.logs))) ||
    reply.username !== localBrowserUsername() ||
    typeof reply.password !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(reply.password)
  )
    throw invalid();
  const origin = new URL(`http://${reply.host}:${String(reply.port)}`).origin;
  return {
    url: origin + (demo ? demonstrationBase.replace(/\/$/, "") : ""),
    signIn: { username: reply.username, password: reply.password },
    pid: reply.pid,
    logs: reply.logs,
  };
}

async function readAccess(
  paths: ReturnType<typeof servicePaths>,
  release: string,
  demo: boolean,
  signal: AbortSignal,
): Promise<Access | undefined> {
  if (!verifySocket(paths.socket, paths.uid)) return undefined;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: paths.socket, signal });
    const chunks: Buffer[] = [];
    let length = 0;
    socket.setTimeout(5000, () => {
      socket.destroy(new Error("The local Workbench service did not complete sign-in discovery"));
    });
    socket.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > maximumReplyBytes) socket.destroy(new Error("The local Workbench service reply is too large"));
      else chunks.push(chunk);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(undefined);
      else reject(error);
    });
    socket.once("end", () => {
      try {
        resolve(decodeAccess(Buffer.concat(chunks), release, demo));
      } catch (error) {
        reject(errorFrom(error));
      }
    });
    socket.once("close", () => {
      resolve(undefined);
    });
  });
}

/** Match the protected control channel and the process that owns the listener lease. */
export async function privateServiceReady(
  distribution: string,
  pid: number,
  stateHome: string,
  signal: AbortSignal,
): Promise<boolean> {
  const paths = servicePaths(stateHome);
  const lock = inspectCacheMetadataLock(paths.lease);
  if (lock.state !== CacheLockState.Active || lock.owner.pid !== pid) return false;
  const access = await readAccess(paths, serviceRelease(distribution), false, signal);
  return access?.pid === pid && inspectCacheMetadataLock(paths.lease).digest === lock.digest;
}

async function openControl(paths: ReturnType<typeof servicePaths>, access: Access, release: string) {
  const clients = new Set<Socket>();
  const address = new URL(access.url);
  const reply = JSON.stringify({
    protocol,
    release,
    host: address.hostname,
    port: Number(address.port || "80"),
    pid: access.pid,
    ...(access.logs ? { logs: access.logs } : {}),
    ...access.signIn,
  });
  const server = createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(1000, () => client.destroy());
    client.end(reply);
  });
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function untilStopped(servers: Server[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let stop: () => void = () => undefined;
  let failure: (error: Error) => void = () => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      stop = resolve;
      failure = reject;
      signal.addEventListener("abort", stop, { once: true });
      for (const server of servers) server.once("error", failure);
    });
  } finally {
    signal.removeEventListener("abort", stop);
    for (const server of servers) server.removeListener("error", failure);
  }
}

async function serveOwned(
  paths: ReturnType<typeof servicePaths>,
  distribution: string,
  options: Options,
  release: string,
  signal: AbortSignal,
  present: Present,
): Promise<boolean> {
  privateDirectory(paths.directory, paths.uid);
  if (verifySocket(paths.socket, paths.uid)) unlinkSync(paths.socket);
  let hub: Hub | undefined;
  let control: Awaited<ReturnType<typeof openControl>> | undefined;
  let abandon: (() => void) | undefined;
  let failure: unknown;
  let yielded = false;
  try {
    abandon = markPrivateListener(paths.directory);
    checkInstalledServiceStart(
      distribution,
      options.mode === "service" && (systemdServiceProcess() || launchdServiceProcess()),
    );
    yielded = systemServicePending();
    if (!yielded) {
      hub = await startProjectHub(distribution, options);
      signal.throwIfAborted();
      const access = { url: hub.url, signIn: hub.signIn, pid: process.pid, logs: options.logs };
      control = await openControl(paths, access, release);
      signal.throwIfAborted();
      if (options.mode === "service") notifySystemdServiceReady();
      present(access, true);
      await untilStopped([hub.server, control.server], signal);
    }
  } catch (error) {
    failure = error;
  }
  await settleCleanup(
    [
      () => control?.close(),
      () => hub?.close(),
      () => abandon?.(),
      () => {
        rmdirSync(paths.directory);
      },
    ],
    failure,
  );
  return yielded;
}

function launchPrivateService(distribution: string, directory: string, options: Options): ChildProcess {
  const args = [join(distribution, "bundle/main.cjs"), "serve", "--service"];
  if (options.host) args.push("--host", options.host);
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.demo) args.push("--demo");
  const child = spawn(process.execPath, args, {
    cwd: directory,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: directory, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

/** The control socket and its credentials remain private to the account, independent of the browser listener. */
export async function runPrivateService(distribution: string, options: Options, present: Present): Promise<void> {
  const cancellation = processCancellation();
  const { signal } = cancellation;
  let child: ChildProcess | undefined;
  let launchFailure: Error | undefined;
  let discoveredPid: number | undefined;
  let announcedWait = false;
  try {
    if (process.platform === "win32") {
      // Keep direct foreground service until the Windows control channel passes native qualification.
      if (options.mode !== "foreground")
        throw new Error("Managed private startup requires an authorized local control channel. Run 'workbench serve'.");
      const lease = windowsPrivateLease();
      mkdirSync(dirname(lease), { recursive: true });
      const owner = inspectCacheMetadataLock(lease);
      if (owner.state === CacheLockState.Abandoned) recoverCacheMetadataLock(lease, { expected: owner.digest });
      await withCacheLocksSync(
        [lease],
        async () => {
          checkInstalledServiceStart(distribution, false);
          const hub = await startProjectHub(distribution, options);
          try {
            if (!signal.aborted)
              present({ url: hub.url, signIn: hub.signIn, pid: process.pid, logs: options.logs }, true);
            await untilStopped([hub.server], signal);
          } finally {
            await hub.close();
          }
        },
        { mutable: false },
      );
      return;
    }
    const paths = servicePaths(),
      release = serviceRelease(distribution);
    while (!signal.aborted) {
      const lock = inspectCacheMetadataLock(paths.lease);
      if (options.mode !== "service" && lock.state !== CacheLockState.Active) {
        const shared = await discoverSystemService(distribution, options.demo ?? false, signal);
        if (shared) {
          present(shared, false);
          return;
        }
      }
      if (lock.state === CacheLockState.Unlocked) {
        if (systemServicePending()) {
          if (!announcedWait) {
            diagnostic(
              LogLevel.Info,
              DiagnosticOperation.WebService,
              DiagnosticOutcome.Waiting,
              {},
              undefined,
              "waiting for the shared Workbench listener",
            );
            announcedWait = true;
          }
        } else if (options.mode === "daemon") {
          if (!child) {
            child = launchPrivateService(distribution, dirname(paths.lease), options);
            child.once("error", (error) => {
              launchFailure = new Error("Could not launch the private Workbench service", { cause: error });
            });
            child.once("exit", (code, reason) => {
              launchFailure = new Error(
                `Private Workbench service exited before discovery (${String(reason ?? code)}). Inspect 'workbench logs' or run 'workbench serve' in the foreground.`,
              );
            });
          }
        } else {
          let owned: Promise<boolean> | undefined;
          try {
            owned = withCacheLocksSync(
              [paths.lease],
              () => serveOwned(paths, distribution, options, release, signal, present),
              { mutable: false },
            );
          } catch (error) {
            if (!(error instanceof CacheBusy)) throw error;
          }
          if (owned && !(await owned)) return;
        }
      } else if (lock.state === CacheLockState.Abandoned) {
        try {
          recoverCacheMetadataLock(paths.lease, { expected: lock.digest });
        } catch (error) {
          if (
            inspectCacheMetadataLock(paths.lease).digest === lock.digest &&
            inspectCacheMetadataLock(`${paths.lease}.recovery`).state !== CacheLockState.Active
          )
            throw error;
        }
      } else if (options.mode === "service") {
        if (!announcedWait) {
          diagnostic(
            LogLevel.Info,
            DiagnosticOperation.WebService,
            DiagnosticOutcome.Waiting,
            {},
            undefined,
            "waiting for the current private Workbench listener to stop",
          );
          announcedWait = true;
        }
      } else if (lock.state === CacheLockState.Active) {
        const found = await readAccess(paths, release, options.demo ?? false, signal);
        if (found?.pid === lock.owner.pid) {
          discoveredPid = found.pid;
          present(found, false);
          return;
        }
      }
      if (launchFailure) throw launchFailure;
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally {
    if (child?.pid !== undefined && child.pid !== discoveredPid && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    cancellation.close();
  }
}
