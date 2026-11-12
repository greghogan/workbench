import { setTimeout as delay } from "node:timers/promises";

/** A generous hang watchdog belongs to the harness, not the behavior being asserted. */
export async function waitForCondition(
  predicate: () => boolean,
  completion: Promise<unknown>,
  label: string,
  signal = AbortSignal.timeout(120000),
) {
  const state: { stopped: boolean; failure?: unknown } = { stopped: false };
  void completion.then(
    () => {
      state.stopped = true;
    },
    (error: unknown) => {
      state.stopped = true;
      state.failure = error;
    },
  );
  while (!predicate()) {
    if (state.stopped)
      throw state.failure instanceof Error
        ? state.failure
        : new Error(`Operation ended before ${label}`, { cause: state.failure });
    try {
      await delay(10, undefined, { signal });
    } catch (error) {
      throw new Error(`Test synchronization watchdog: ${label}`, { cause: error });
    }
  }
}
