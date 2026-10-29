import { errorFrom } from "./values.mjs";
import { combineFailures } from "./diagnostic-errors.mjs";
import { positiveInteger } from "./cpu-budget.mjs";

/** A jobserver client can supply leases without coupling processors to its transport or installation. */
export interface WorkLease {
  release(): void | Promise<void>;
}
export interface WorkAdmission {
  acquire(signal?: AbortSignal): Promise<WorkLease>;
}

/** Available workers claim the next item; a failed queue drains admitted work before returning. */
export async function workQueue<T>(
  items: readonly T[],
  options: { capacity: number; signal?: AbortSignal; admission?: WorkAdmission },
  visit: (item: T) => Promise<void>,
): Promise<void> {
  positiveInteger(options.capacity, "work queue capacity");
  options.signal?.throwIfAborted();
  const pending = items.values();
  let failed = false;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(options.capacity, items.length) }, async () => {
      while (!failed) {
        const item = pending.next();
        if (item.done) return;
        try {
          await admittedWork(options.admission, options.signal, () => visit(item.value));
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
  if (failures.length === 1) throw errorFrom(failures[0]);
  if (failures.length) throw new AggregateError(failures, "Queued work failed after draining active jobs");
}

/** Ordered results share the queue's admission, cancellation, and draining guarantees. */
export async function mapWork<T, R>(
  items: readonly T[],
  options: Parameters<typeof workQueue>[1],
  visit: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  await workQueue(
    items.map((item, index) => ({ item, index })),
    options,
    async ({ item, index }) => {
      results[index] = await visit(item);
    },
  );
  return results;
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
