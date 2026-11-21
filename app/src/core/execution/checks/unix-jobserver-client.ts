import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { systemRuntimeDirectory, verifySystemPath } from "../../distribution/unix-system-authority.js";
import { combineFailures } from "../../diagnostics/diagnostic-errors.mjs";
import { writeDiagnosticText } from "../../diagnostics/diagnostics.mjs";
import { isRecord } from "../../runtime/values.mjs";
import { acquireProcessLock, type ProcessLock } from "../../storage/process-lock.js";
import {
  jobserverPaths,
  jobserverProject,
  jobserverProtocol,
  readJobFrames,
  sendJobFrame,
} from "./unix-jobserver-protocol.js";

export function unixJobserverIdentity(): string | undefined {
  if ((process.platform !== "linux" && process.platform !== "darwin") || process.getuid?.() === 0) return undefined;
  const runtime = systemRuntimeDirectory();
  const endpoint = lstatSync(jobserverPaths(runtime).socket, { bigint: true, throwIfNoEntry: false });
  if (!endpoint) return undefined;
  verifySystemPath(runtime);
  if (!endpoint.isSocket() || endpoint.uid !== 0n)
    throw new Error("The machine jobserver socket is not administrator-owned");
  return (endpoint.mode & 0o222n) === 0o222n ? `${String(endpoint.dev)}:${String(endpoint.ino)}` : undefined;
}

export async function findUnixJobserver(signal: AbortSignal): Promise<string | undefined> {
  const identity = unixJobserverIdentity();
  if (!identity) return undefined;
  return new Promise((resolve, reject) => {
    const probe = createConnection({ path: jobserverPaths(systemRuntimeDirectory()).socket, signal });
    probe.once("connect", () => {
      resolve(identity);
      probe.destroy();
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(undefined);
      else reject(error);
    });
    probe.setTimeout(5000, () => {
      probe.destroy(new Error("Machine jobserver discovery timed out"));
    });
  });
}

export async function withUnixJobLease<T>(
  expected: string,
  project: string,
  signal: AbortSignal,
  action: (owner: ProcessLock, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (!jobserverProject.test(project)) throw new Error("Invalid project identity for machine job admission");
  if (unixJobserverIdentity() !== expected)
    throw new Error("The machine jobserver stopped or restarted during this check run");
  const paths = jobserverPaths(systemRuntimeDirectory());
  const inbox = lstatSync(paths.inbox);
  if (!inbox.isDirectory() || inbox.uid !== 0 || (inbox.mode & 0o7777) !== 0o1733)
    throw new Error("The machine job request directory is unavailable");
  const claim = randomUUID();
  const owner = acquireProcessLock(join(paths.inbox, claim), true);
  if (!owner) throw new Error("Could not retain machine job ownership");
  const lost = new AbortController();
  const socket = createConnection(paths.socket);
  const stopWaiting = () => {
    socket.destroy();
  };
  const close = () => {
    signal.removeEventListener("abort", stopWaiting);
    try {
      owner.release();
    } finally {
      socket.destroy();
    }
  };
  let result: T;
  try {
    await new Promise<void>((resolve, reject) => {
      let granted = false;
      socket.setTimeout(5000, () => socket.destroy(new Error("Machine jobserver connection timed out")));
      socket.once("connect", () => {
        try {
          if (unixJobserverIdentity() !== expected) throw new Error("The machine jobserver changed while connecting");
          socket.setTimeout(0);
          sendJobFrame(socket, { version: jobserverProtocol, project, claim });
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error("Could not verify the machine jobserver"));
        }
      });
      const connectionLost = (failure: Error) => {
        if (granted) lost.abort(failure);
        else reject(failure);
      };
      socket.on("error", connectionLost);
      socket.once("close", () => {
        connectionLost(new Error("Connection to the machine jobserver closed"));
      });
      readJobFrames(socket, (reply) => {
        if (isRecord(reply) && reply.state === "waiting" && typeof reply.reason === "string" && !granted) {
          writeDiagnosticText(`Waiting for the machine jobserver (${reply.reason}).`);
        } else if (isRecord(reply) && reply.state === "granted" && !granted) {
          granted = true;
          resolve();
        } else if (isRecord(reply) && reply.state === "error" && typeof reply.message === "string") {
          socket.destroy(new Error(reply.message));
        } else socket.destroy(new Error("Invalid machine jobserver response"));
      });
      signal.addEventListener("abort", stopWaiting, { once: true });
      if (signal.aborted) stopWaiting();
    });
    signal.removeEventListener("abort", stopWaiting);
    const execution = AbortSignal.any([signal, lost.signal]);
    execution.throwIfAborted();
    result = await action(owner, execution);
    execution.throwIfAborted();
  } catch (error) {
    const failure: unknown = signal.aborted ? signal.reason : error;
    try {
      close();
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "Machine job and process cleanup failed");
    }
    throw failure;
  }
  close();
  return result;
}
