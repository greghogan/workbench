import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { userConfigValues } from "../../core/configuration/user-config.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
import { HostActivitySampler } from "../../core/execution/checks/host-activity.js";
import { configuredMachineAdmission } from "../../core/execution/checks/machine-admission.js";
import {
  jobserverClaim,
  jobserverPaths,
  jobserverProject,
  jobserverProtocol,
  maximumJobserverWorkers,
  readJobFrames,
  sendJobFrame,
  unixWorkerFifoSupported,
} from "../../core/execution/checks/unix-jobserver-protocol.js";
import type { WorkLease } from "../../core/execution/checks/work-admission.mjs";
import { writeNew } from "../../core/runtime/file-publication.mjs";
import { readBoundedFile } from "../../core/runtime/file-reads.js";
import { errorFrom, isRecord } from "../../core/runtime/values.mjs";
import { inspectProcessOwner } from "../../core/storage/process-lock.js";
import { listenUnix } from "./http-listener.js";
import { UnixWorkerPipe } from "./unix-worker-pipe.js";

interface Claim {
  uid: number;
  device: string;
  inode: string;
  token: string;
}

function claimDirectory(path: string) {
  const status = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (status?.isDirectory() && status.uid > 0n && (status.mode & 0o7777n) === 0o700n)
    return { uid: Number(status.uid), device: String(status.dev), inode: String(status.ino) };
  return undefined;
}

function processOwner(directory: string, uid: number) {
  try {
    const file = openSync(
      join(directory, "owner.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const status = fstatSync(file);
      if (!status.isFile() || status.uid !== uid || status.mode & 0o077 || status.size > 256 * 1024) return undefined;
      const contents = Buffer.alloc(status.size + 1);
      let size = 0;
      while (size < contents.length) {
        const count = readSync(file, contents, size, contents.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size !== status.size) return undefined;
      return inspectProcessOwner(JSON.parse(contents.subarray(0, size).toString("utf8")));
    } finally {
      closeSync(file);
    }
  } catch {
    return undefined;
  }
}

function authorise(directory: string): Claim | undefined {
  const caller = claimDirectory(directory);
  if (!caller) return undefined;
  const owner = processOwner(directory, caller.uid);
  if (!owner || owner.abandoned) return undefined;
  return { ...caller, token: owner.token };
}

function drained(directory: string, claim: Claim): boolean {
  if (!lstatSync(directory, { throwIfNoEntry: false })) return true;
  const caller = claimDirectory(directory);
  if (caller?.uid !== claim.uid || caller.device !== claim.device || caller.inode !== claim.inode) return false;
  const owner = processOwner(directory, caller.uid);
  return owner?.token === claim.token && owner.abandoned;
}

function ownDirectory(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.uid !== 0) throw new Error(`Unprotected jobserver directory: ${path}`);
  chmodSync(path, mode);
}

function recoverClaims(directory: string) {
  const entries = readdirSync(directory).filter((entry) => jobserverClaim.test(entry));
  if (entries.length > 4096) throw new Error("Too many retained machine job leases");
  return new Map(
    entries.map((entry) => {
      const value: unknown = JSON.parse(readBoundedFile(join(directory, entry), 4096, "job lease").toString());
      if (
        !isRecord(value) ||
        typeof value.uid !== "number" ||
        !Number.isSafeInteger(value.uid) ||
        value.uid <= 0 ||
        typeof value.device !== "string" ||
        !/^\d+$/.test(value.device) ||
        typeof value.inode !== "string" ||
        !/^\d+$/.test(value.inode) ||
        typeof value.token !== "string" ||
        !jobserverClaim.test(value.token)
      )
        throw new Error(`Invalid retained machine job lease: ${entry}`);
      return [entry, { uid: value.uid, device: value.device, inode: value.inode, token: value.token }];
    }),
  );
}

/** The supervisor admits work. The authenticated caller retains execution and process ownership. */
export async function startUnixJobserver(runtime: string, preferences: ReturnType<typeof userConfigValues>) {
  const paths = jobserverPaths(runtime);
  ownDirectory(paths.inbox, 0o1733);
  ownDirectory(paths.receipts, 0o700);
  const endpoint = lstatSync(paths.socket, { throwIfNoEntry: false });
  if (endpoint && (!endpoint.isSocket() || endpoint.uid !== 0))
    throw new Error("The jobserver socket path is occupied");
  if (endpoint) unlinkSync(paths.socket);

  const admission = configuredMachineAdmission(preferences);
  const sampler = new HostActivitySampler();
  const recovered = recoverClaims(paths.receipts);
  const active = new Map<string, { claim: Claim; lease: WorkLease; socket: Socket; pipe?: UnixWorkerPipe }>();
  const connections = new Set<Socket>();
  const pending = new Map<Socket, string | undefined>();
  const claims = new Set<string>();
  const stop = new AbortController();
  admission.observe({ memoryPressure: true });
  let monitoringFailure: Error | undefined;
  const failMonitoring = (error: unknown) => {
    if (stop.signal.aborted) return;
    monitoringFailure = errorFrom(error);
    diagnostic(LogLevel.Error, DiagnosticOperation.WebService, DiagnosticOutcome.Failed, {}, monitoringFailure);
    stop.abort();
    admission.close();
    for (const socket of connections) socket.destroy();
  };
  let workerPoolRecovering = false;
  const server = createServer((socket) => {
    const disconnect = new AbortController();
    let requested = false;
    let id: string | undefined;
    connections.add(socket);
    socket.setTimeout(5000, () => {
      socket.destroy();
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      connections.delete(socket);
      pending.delete(socket);
      disconnect.abort();
      if (id && !active.has(id)) claims.delete(id);
    });
    const reject = (message: string) => socket.end(JSON.stringify({ state: "error", message }) + "\n");
    readJobFrames(socket, (request) => {
      if (
        requested ||
        !isRecord(request) ||
        request.version !== jobserverProtocol ||
        typeof request.claim !== "string" ||
        !jobserverClaim.test(request.claim) ||
        typeof request.project !== "string" ||
        !jobserverProject.test(request.project) ||
        (request.workers !== undefined &&
          (!unixWorkerFifoSupported ||
            typeof request.workers !== "number" ||
            !Number.isSafeInteger(request.workers) ||
            request.workers < 1 ||
            request.workers > maximumJobserverWorkers))
      ) {
        reject("Invalid machine job request");
        return;
      }
      requested = true;
      socket.setTimeout(0);
      const identifier = request.claim;
      const workers = typeof request.workers === "number" ? request.workers : undefined;
      const claim = authorise(join(paths.inbox, identifier));
      if (!claim || claims.has(identifier) || recovered.has(identifier)) {
        reject("Could not verify the account owning the machine job");
        return;
      }
      id = identifier;
      claims.add(identifier);
      pending.set(socket, undefined);
      void admission
        .acquire(request.project, disconnect.signal)
        .then(async (lease) => {
          pending.delete(socket);
          if (socket.destroyed) {
            await lease.release();
            return;
          }
          let pipe: UnixWorkerPipe | undefined;
          try {
            if (workers !== undefined) {
              pipe = new UnixWorkerPipe(join(paths.inbox, `${identifier}.fifo`), claim.uid, workers - 1, lease);
              // Some tools check the pool only when dispatching work, so lend available slots before their first check.
              pipe.supply(active.size === 0 ? maximumJobserverWorkers : 1);
            }
            writeNew(join(paths.receipts, identifier), JSON.stringify(claim), 0o600);
          } catch (error) {
            pipe?.close();
            await lease.release();
            throw error;
          }
          active.set(identifier, { claim, lease, socket, ...(pipe ? { pipe } : {}) });
          sendJobFrame(socket, { state: "granted" });
        })
        .catch(() => {
          pending.delete(socket);
          if (!socket.destroyed) reject("Machine job admission is unavailable");
        });
    });
  });
  server.maxConnections = 4096;
  await listenUnix(server, paths.socket);
  server.on("error", failMonitoring);
  try {
    chmodSync(paths.socket, 0o666);
  } catch (error) {
    server.close();
    throw error;
  }
  const monitoring = (async () => {
    while (!stop.signal.aborted) {
      for (const [id, claim] of recovered)
        if (drained(join(paths.inbox, id), claim)) {
          unlinkSync(join(paths.receipts, id));
          recovered.delete(id);
        }
      for (const [id, { claim, lease, socket, pipe }] of active)
        if (socket.destroyed && drained(join(paths.inbox, id), claim)) {
          pipe?.close();
          unlinkSync(join(paths.receipts, id));
          active.delete(id);
          claims.delete(id);
          await lease.release();
        }
      const pipes = [...active.values()].flatMap(({ pipe, socket }) => (pipe ? [{ pipe, socket }] : []));
      if (!pipes.length) workerPoolRecovering = false;
      if (recovered.size || workerPoolRecovering || (!active.size && !pending.size))
        admission.observe({ memoryPressure: true });
      else admission.observe(await sampler.sample());
      if (!recovered.size && !workerPoolRecovering) {
        try {
          for (const { pipe, socket } of pipes) {
            if (admission.inspect().reason === "worker slots") pipe.withdraw();
            else if (pending.size === 0 && !socket.destroyed)
              pipe.supply(pipes.length === 1 ? maximumJobserverWorkers : 1);
          }
        } catch (error) {
          workerPoolRecovering = true;
          admission.observe({ memoryPressure: true });
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.WebService,
            DiagnosticOutcome.Waiting,
            {},
            error,
            "Machine worker admission paused until the current build tools exit",
          );
        }
      }
      const reason = recovered.size
        ? "cleanup of previously admitted work"
        : workerPoolRecovering
          ? "worker pool recovery"
          : admission.inspect().reason;
      if (reason)
        for (const [socket, previous] of pending)
          if (previous !== reason && !socket.destroyed && !socket.writableNeedDrain) {
            pending.set(socket, reason);
            sendJobFrame(socket, { state: "waiting", reason });
          }
      await delay(250, undefined, { signal: stop.signal });
    }
  })().catch(failMonitoring);
  return {
    async close(): Promise<void> {
      admission.close();
      stop.abort();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await monitoring;
      for (const { pipe } of active.values()) pipe?.close();
      if (monitoringFailure) throw monitoringFailure;
    },
  };
}
