import type { CacheSize } from "../cache-size.js";
/** Two independent walks publish progress without admitting an unbounded filesystem workload. */
export async function measureSizes(
  sizes: readonly CacheSize[],
  visit: (size: CacheSize) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(2, sizes.length) }, async () => {
      while (!failed) {
        const size = sizes[next++];
        if (!size) return;
        try {
          await visit(size);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason as unknown;
}
