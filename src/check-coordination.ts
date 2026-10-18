import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildCheckout } from "./builds.js";
import { userDirectory } from "./storage.js";
import { withToolCacheAdmissionAsync } from "./tool-cache-lock.js";
import { acquireProcessLock, type ProcessLock } from "./process-lock.js";
import { releaseAfterFailure } from "./cache-lock.js";
import type { CheckCancellation } from "./check-cancellation.js";

/** A working tree and its staged snapshots share admission; inputs and results are read only after admission. */
export async function withCheckCoordination<T>(
  root: string,
  cancellation: CheckCancellation,
  action: (owner: ProcessLock) => Promise<T>,
): Promise<T> {
  const checkout = process.env.WORKBENCH_LOCAL_CONFIG_ROOT
    ? realpathSync(process.env.WORKBENCH_LOCAL_CONFIG_ROOT)
    : buildCheckout(realpathSync(root));
  const key = createHash("sha256").update(checkout).digest("hex");
  const directory = join(userDirectory("cache"), "check-gates", key);
  const deadline = Date.now() + 30 * 60 * 1000;
  let waiting = false;
  for (;;) {
    cancellation.checkpoint();
    const owner = await withToolCacheAdmissionAsync(() => acquireProcessLock(directory, true), cancellation.signal);
    if (owner) {
      let result: T;
      try {
        cancellation.checkpoint();
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
      console.log(
        "Waiting for another check gate in this checkout; inputs will be checked again when it finishes. Ctrl-C cancels this wait.",
      );
      waiting = true;
    }
    if (Date.now() >= deadline) throw new Error(`Check gate is still busy or needs recovery: ${directory}`);
    await delay(100, undefined, { signal: cancellation.signal });
  }
}
