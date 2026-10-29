import { afterEach, expect, test, vi } from "vitest";
import { dockerQuery } from "../src/docker-query.ts";
import { describeError } from "../scripts/diagnostic-errors.mjs";

const requests = vi.hoisted(
  () => [] as { signal?: AbortSignal; complete: (error: Error | null, stdout: string) => void }[],
);
vi.mock("../scripts/owned-child.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/owned-child.mjs")>()),
  captureOwnedChild: (_command: string, _args: string[], options: { signal: AbortSignal }) =>
    new Promise((resolve) => {
      requests.push({
        signal: options.signal,
        complete: (error, stdout) => {
          resolve({
            pid: 1,
            status: error ? 1 : 0,
            signal: null,
            ...(error ? { error } : {}),
            stdout,
            stderr: error?.message ?? "",
          });
        },
      });
    }),
}));

afterEach(() => {
  requests.splice(0);
  vi.useRealTimers();
});
test("slow inventory remains pending until measurement completes without blocking other work", async () => {
  vi.useFakeTimers();
  let settled = false;
  const result = dockerQuery(["system", "df"], new AbortController().signal).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  expect(settled).toBe(false);
  requests[0]?.complete(null, " measured bytes \n");
  await expect(result).resolves.toBe("measured bytes");
});
test("cancellation waits for child completion and remains cancellation rather than empty inventory", async () => {
  const controller = new AbortController();
  const result = dockerQuery(["system", "df"], controller.signal);
  controller.abort();
  expect(requests[0]?.signal?.aborted).toBe(true);
  requests[0]?.complete(new Error("child aborted"), "");
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});
test("inventory failure retains the Docker cause in its rendered diagnostic", async () => {
  const result = dockerQuery(["system", "df"], new AbortController().signal);
  requests[0]?.complete(new Error("daemon unavailable"), "");
  await expect(result.catch((error: unknown) => describeError(error))).resolves.toContain("daemon unavailable");
});
