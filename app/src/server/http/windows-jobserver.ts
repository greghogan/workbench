import { lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { userConfigValues } from "../../core/configuration/user-config.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
import { HostActivitySampler } from "../../core/execution/checks/host-activity.js";
import { configuredMachineAdmission, type MachineLease } from "../../core/execution/checks/machine-admission.js";
import {
  windowsJobControl,
  windowsJobId,
  windowsJobPid,
  windowsJobProject,
  windowsJobSid,
} from "../../core/execution/checks/windows-jobserver-protocol.js";
import { writeNew } from "../../core/runtime/file-publication.mjs";
import { readBoundedFile } from "../../core/runtime/file-reads.js";
import { isRecord } from "../../core/runtime/values.mjs";
import { userDirectory } from "../../core/storage/storage.js";

interface Claim {
  sid: string;
  pid: string;
  creation: string;
}
interface Connection {
  claim: Claim;
  stop: AbortController;
  seenAt: number;
  lease?: MachineLease;
}
const receiptLimit = 4096;
const heartbeatTimeout = 10_000;

function retainedClaims(directory: string): Map<string, Claim> {
  const entries = readdirSync(directory);
  if (entries.length > receiptLimit) throw new Error("Too many retained Windows machine job leases");
  return new Map(
    entries.map((id) => {
      if (!windowsJobId.test(id)) throw new Error("Invalid retained Windows machine job identifier");
      const data: unknown = JSON.parse(readBoundedFile(join(directory, id), 4096, "machine job lease").toString());
      if (
        !isRecord(data) ||
        typeof data.sid !== "string" ||
        !windowsJobSid.test(data.sid) ||
        typeof data.pid !== "string" ||
        !windowsJobPid.test(data.pid) ||
        typeof data.creation !== "string" ||
        !/^[1-9]\d{0,19}$/.test(data.creation)
      )
        throw new Error("Invalid retained Windows machine job lease");
      return [id, { sid: data.sid, pid: data.pid, creation: data.creation }];
    }),
  );
}

export function startWindowsJobserver(
  helper: string,
  generation: string,
  preferences: ReturnType<typeof userConfigValues>,
) {
  const directory = join(userDirectory("state"), "job-leases");
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) throw new Error("The Windows machine job lease path is occupied");
  const recovered = retainedClaims(directory);
  const admission = configuredMachineAdmission(preferences);
  const sampler = new HostActivitySampler();
  const connections = new Map<string, Connection>();
  const stop = new AbortController();
  admission.observe({ memoryPressure: true });
  let failure: unknown;
  const observe = async (id: string, pid: string, sid: string) => {
    const result = await windowsJobControl(helper, ["job-observe", id, pid, sid], stop.signal);
    const { creation, present, active } = result;
    if (
      typeof creation !== "string" ||
      !/^\d{1,20}$/.test(creation) ||
      typeof present !== "boolean" ||
      typeof active !== "number" ||
      !Number.isSafeInteger(active) ||
      active < 0
    )
      throw new Error("The Windows machine job supervisor returned an invalid process observation");
    return { creation, present, active };
  };
  const drained = async (id: string, claim: Claim): Promise<boolean> => {
    const observation = await observe(id, claim.pid, claim.sid);
    return observation.creation !== claim.creation && observation.active === 0;
  };
  const monitoring = (async () => {
    while (!stop.signal.aborted) {
      for (const [id, claim] of recovered)
        if (await drained(id, claim)) {
          unlinkSync(join(directory, id));
          recovered.delete(id);
        }
      for (const [id, connection] of connections) {
        if (performance.now() - connection.seenAt <= heartbeatTimeout) continue;
        connection.stop.abort();
        if (connection.lease) {
          if (!(await drained(id, connection.claim))) continue;
          unlinkSync(join(directory, id));
          await connection.lease.release();
        }
        connections.delete(id);
      }
      if (recovered.size || !connections.size) admission.observe({ memoryPressure: true });
      else admission.observe(await sampler.sample());
      await delay(250, undefined, { signal: stop.signal });
    }
  })().catch((error: unknown) => {
    if (!stop.signal.aborted) {
      failure = error;
      admission.close();
      diagnostic(LogLevel.Error, DiagnosticOperation.WebService, DiagnosticOutcome.Failed, {}, error);
    }
  });

  return {
    async request(frame: string) {
      const [prefix, sid, operation, ...fields] = frame.split(" ");
      if (prefix !== "jobs" || !sid || !windowsJobSid.test(sid))
        return { error: "Invalid Windows machine job account" };
      if (failure !== undefined) return { error: "Windows machine job admission is unavailable" };
      if (operation === "probe" && !fields.length) return { state: "ready", generation };
      const [id, expected, project, pid, ...extra] = fields;
      if (!id || !windowsJobId.test(id) || expected !== generation || extra.length)
        return { error: "The Windows machine jobserver request is invalid or refers to a previous service" };
      let entry = connections.get(id);
      if (
        operation === "start" &&
        !entry &&
        project &&
        windowsJobProject.test(project) &&
        pid &&
        windowsJobPid.test(pid)
      ) {
        if (connections.size + recovered.size >= receiptLimit || recovered.has(id))
          return { error: "Windows machine job admission is full" };
        const process = await observe(id, pid, sid);
        if (!process.present || process.creation === "0" || process.active !== 0)
          return { error: "Could not confirm the caller's Windows job supervisor is awaiting admission" };
        const connection: Connection = {
          claim: { sid, pid, creation: process.creation },
          seenAt: performance.now(),
          stop: new AbortController(),
        };
        entry = connection;
        connections.set(id, connection);
        void admission
          .acquire(project, connection.stop.signal)
          .then(async (lease) => {
            if (connection.stop.signal.aborted) {
              await lease.release();
              return;
            }
            try {
              writeNew(join(directory, id), JSON.stringify(connection.claim), 0o600);
              connection.lease = lease;
            } catch (error) {
              await lease.release();
              throw error;
            }
          })
          .catch((error: unknown) => {
            if (!connection.stop.signal.aborted)
              diagnostic(LogLevel.Warn, DiagnosticOperation.WebService, DiagnosticOutcome.Failed, {}, error);
            connection.stop.abort();
          });
      } else if (!(["poll", "release"].includes(operation ?? "") && fields.length === 2)) {
        return { error: "Invalid Windows machine job request" };
      }
      if (entry?.claim.sid !== sid) return { error: "The Windows machine job request is unavailable" };
      if (operation === "release") {
        entry.seenAt = Number.NEGATIVE_INFINITY;
        entry.stop.abort();
        return { state: "released", generation };
      }
      if (entry.stop.signal.aborted) return { error: "The Windows machine job has ended" };
      entry.seenAt = performance.now();
      return entry.lease
        ? { state: "granted", generation }
        : {
            state: "waiting",
            generation,
            reason: recovered.size
              ? "cleanup of previously admitted work"
              : (admission.inspect().reason ?? "queued work"),
          };
    },
    close: async () => {
      stop.abort();
      admission.close();
      await monitoring;
    },
  };
}
