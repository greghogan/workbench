import { errorFrom } from "./values.mjs";
import { combineFailures } from "./diagnostic-errors.mjs";

/** A jobserver client can supply leases without coupling processors to its transport or installation. */
export interface WorkLease {
  release(): void | Promise<void>;
}
export interface WorkAdmission {
  acquire(signal?: AbortSignal): Promise<WorkLease>;
}
export async function admittedWork<T>(
  admission: WorkAdmission | undefined,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const lease = await admission?.acquire(signal);
  const outcome = await (async () => {
    try {
      signal?.throwIfAborted();
      return { ok: true, value: await action() } as const;
    } catch (error) {
      return { ok: false, error } as const;
    }
  })();
  try {
    await lease?.release();
  } catch (cleanup) {
    if (!outcome.ok) throw combineFailures(outcome.error, cleanup, "Work and capacity release failed");
    throw cleanup;
  }
  if (!outcome.ok) throw errorFrom(outcome.error);
  return outcome.value;
}
