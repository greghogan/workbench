import { writeDiagnosticText } from "./diagnostics.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildCheckout, interruptedBuildLock } from "./builds.js";
import { userDirectory } from "./storage.js";
import { withToolCacheAdmissionAsync } from "./tool-cache-lock.js";
import { acquireProcessLock, inspectProcessLock, type ProcessLock } from "./process-lock.js";
import { releaseAfterFailure } from "./cache-lock.js";
import type { CheckCancellation } from "./check-cancellation.js";
import { projectRegistration, Registration } from "./project-registry.js";

export function checkCoordinationDirectory(checkout: string): string {
  return join(userDirectory("cache"), "check-gates", createHash("sha256").update(checkout).digest("hex"));
}

/** A working tree and its staged snapshots share admission; inputs and results are read only after admission. */
export async function withCheckCoordination<T>(
  root: string,
  cancellation: CheckCancellation,
  action: (owner: ProcessLock) => Promise<T>,
): Promise<T> {
  const checkout = process.env.WORKBENCH_LOCAL_CONFIG_ROOT
    ? realpathSync(process.env.WORKBENCH_LOCAL_CONFIG_ROOT)
    : buildCheckout(realpathSync(root));
  const directory = checkCoordinationDirectory(checkout);
  const deadline = Date.now() + 30 * 60 * 1000;
  const started = Date.now();
  let attempts = 0;
  let waiting = false;
  let recovering: string | undefined;
  for (;;) {
    attempts++;
    cancellation.checkpoint();
    const owner = await withToolCacheAdmissionAsync(() => {
      recovering = inspectProcessLock(directory).abandoned ? interruptedBuildLock(checkout) : undefined;
      return recovering ? undefined : acquireProcessLock(directory, true);
    }, cancellation.signal);
    if (owner) {
      let result: T;
      try {
        cancellation.checkpoint();
        if (projectRegistration(checkout) === Registration.Declined)
          throw new Error(
            `Project registration was removed while waiting. To register: workbench project add ${JSON.stringify(checkout)}`,
          );
        result = await action(owner);
        cancellation.checkpoint();
      } catch (failure) {
        releaseAfterFailure(
          () => {
            owner.release();
          },
          failure,
          "Check gate and ownership release both failed",
        );
      }
      owner.release();
      return result;
    }
    if (!waiting) {
      writeDiagnosticText(
        "Waiting for another check gate in this checkout; inputs will be checked again when it finishes. Ctrl-C cancels this wait.",
      );
      waiting = true;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Check gate is still busy or needs recovery: ${directory}; waited ${String(Date.now() - started)} ms (${String(attempts)} attempts)${recovering ? `; waiting for interrupted build ownership: ${recovering}` : ""}`,
      );
    await delay(100, undefined, { signal: cancellation.signal });
  }
}
