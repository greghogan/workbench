import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { combineFailures } from "../../diagnostics/diagnostic-errors.mjs";
import { writeDiagnosticText } from "../../diagnostics/diagnostics.mjs";
import { windowsMainService, windowsServiceHelper } from "../../distribution/windows-service.js";
import { runOwnedChild, type ChildOutcome } from "../../runtime/owned-child.mjs";
import { isRecord } from "../../runtime/values.mjs";
import { windowsJobControl, windowsJobId, windowsJobProject } from "./windows-jobserver-protocol.js";

const refreshMilliseconds = 500;
const absentService = new Set([2, 1060, 1062]);

async function request(helper: string, command: string, signal: AbortSignal) {
  const reply = await windowsJobControl(helper, ["job-control", windowsMainService, command], signal);
  if (typeof reply.error === "string") throw new Error(reply.error);
  if (
    typeof reply.generation !== "string" ||
    !windowsJobId.test(reply.generation) ||
    !["ready", "waiting", "granted", "released"].some((state) => state === reply.state)
  )
    throw new Error("Invalid Windows machine jobserver reply");
  return reply;
}

export async function findWindowsJobserver(distribution: string, signal: AbortSignal): Promise<string | undefined> {
  const helper = windowsServiceHelper(distribution);
  if (!helper) return undefined;
  try {
    const reply = await request(helper, "probe", signal);
    if (reply.state !== "ready") throw new Error("Invalid Windows machine jobserver discovery reply");
    return String(reply.generation);
  } catch (error) {
    if (isRecord(error) && typeof error.code === "number" && absentService.has(error.code)) return undefined;
    throw new Error("Could not verify the Windows machine jobserver", { cause: error });
  }
}

export async function runWindowsAdmittedCheck(
  distribution: string,
  generation: string,
  project: string,
  command: string,
  args: string[],
  signal: AbortSignal,
) {
  const helper = windowsServiceHelper(distribution);
  if (!helper || !windowsJobId.test(generation) || !windowsJobProject.test(project))
    throw new Error("The Windows machine jobserver is unavailable");
  const id = randomBytes(16).toString("hex");
  const identity = `${id} ${generation}`;
  const finished = new AbortController();
  const lost = new AbortController();
  const execution = AbortSignal.any([signal, lost.signal]);
  const lifecycle: { monitor?: Promise<void>; requested: boolean } = { requested: false };
  const close = async () => {
    finished.abort();
    await lifecycle.monitor;
    if (lifecycle.requested) await request(helper, `release ${identity}`, AbortSignal.timeout(5000));
  };
  let result: ChildOutcome;
  try {
    result = await runOwnedChild(command, args, {
      cwd: process.cwd(),
      env: process.env,
      signal: execution,
      stopDescendantsOnExit: true,
      windowsAdmission: {
        jobId: id,
        async wait(pid, signal) {
          lifecycle.requested = true;
          let reply = await request(helper, `start ${identity} ${project} ${String(pid)}`, signal);
          let reason: unknown;
          while (reply.generation === generation && reply.state === "waiting") {
            if (typeof reply.reason === "string" && reason !== reply.reason) {
              reason = reply.reason;
              writeDiagnosticText(`Waiting for the machine jobserver (${reply.reason}).`);
            }
            await delay(refreshMilliseconds, undefined, { signal });
            reply = await request(helper, `poll ${identity}`, signal);
          }
          if (reply.generation !== generation || reply.state !== "granted")
            throw new Error("The Windows machine jobserver stopped or restarted before admission");
          lifecycle.monitor = (async () => {
            while (!finished.signal.aborted) {
              await delay(refreshMilliseconds, undefined, { signal: finished.signal });
              const current = await request(helper, `poll ${identity}`, finished.signal);
              if (current.generation !== generation || current.state !== "granted")
                throw new Error("The Windows machine jobserver stopped or restarted during this check");
            }
          })().catch((reason: unknown) => {
            if (!finished.signal.aborted)
              lost.abort(new Error("Lost admission from the Windows machine jobserver", { cause: reason }));
          });
        },
      },
    });
    execution.throwIfAborted();
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw combineFailures(error, cleanup, "Windows check and lease release both failed");
    }
    throw error;
  }
  await close();
  return result;
}
