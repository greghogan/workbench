import { captureOwnedChild, processCancellation } from "../scripts/owned-child.mjs";
import { processFailure } from "../scripts/process-outcome.mjs";

/** The caller owns cancellation; subprocess groups drain before their worker can exit. */
export async function dockerQuery(args: string[], signal?: AbortSignal): Promise<string> {
  const owner = signal ? undefined : processCancellation();
  const active = signal ?? owner?.signal;
  try {
    if (!active) throw new Error("Docker inventory requires an operation owner");
    const result = await captureOwnedChild(
      "docker",
      args,
      { cwd: process.cwd(), env: process.env, signal: active },
      16 * 1024 * 1024,
    );
    active.throwIfAborted();
    const failure = processFailure("Docker inventory", result, result);
    if (failure) throw failure;
    return result.stdout.trim();
  } catch (error) {
    active?.throwIfAborted();
    throw new Error(`Docker inventory query failed: ${args.slice(0, 2).join(" ")}`, { cause: error });
  } finally {
    owner?.close();
  }
}
