import { captureOwnedChild, processCancellation } from "../scripts/owned-child.mjs";
import { processFailure } from "../scripts/process-outcome.mjs";
import { RegistryProvider, type RegistryManagement } from "./registry-management-contract.js";

function client(management: RegistryManagement): string {
  switch (management.provider) {
    case RegistryProvider.GHCR:
      return "gh";
    case RegistryProvider.GitLab:
      return "glab";
  }
}
/** Each request is bounded and owned; credentials remain in the provider CLI's runtime lookup. */
export async function registryRequest(
  management: RegistryManagement,
  endpoint: string,
  options: { signal?: AbortSignal; method?: "DELETE" | "POST"; input?: unknown } = {},
): Promise<unknown> {
  const owner = options.signal ? undefined : processCancellation();
  const active = options.signal ?? owner?.signal;
  if (!active) throw new Error("Registry request requires an operation owner");
  const signal = AbortSignal.any([active, AbortSignal.timeout(30000)]);
  try {
    const result = await captureOwnedChild(
      client(management),
      [
        "api",
        "--hostname",
        management.host,
        ...(options.method ? ["--method", options.method] : []),
        ...(options.input === undefined ? [] : ["--input", "-"]),
        endpoint,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        signal,
        ...(options.input === undefined ? {} : { input: JSON.stringify(options.input) }),
      },
      16 * 1024 * 1024,
    );
    signal.throwIfAborted();
    const failure = processFailure(`${management.provider} API ${options.method ?? "GET"}`, result, result);
    if (failure) throw failure;
    if (options.method === "DELETE") return undefined;
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("Registry API returned invalid JSON");
    }
  } catch (cause) {
    active.throwIfAborted();
    throw new Error(`${management.provider} API ${options.method ?? "GET"} failed on ${management.host}`, { cause });
  } finally {
    owner?.close();
  }
}
