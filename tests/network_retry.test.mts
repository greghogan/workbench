import { fakeClock, realClock } from "./fixtures/clock.mts";
import assert from "node:assert/strict";
import { required } from "../src/invariants.ts";
import { afterEach, expect, test, vi } from "vitest";
import {
  AcquisitionRejected,
  AcquisitionReason,
  NetworkUnavailable,
  NetworkRetryExhausted,
  retryNetwork,
  networkResponse,
  transientNetworkFailure,
  retryAfterMilliseconds,
} from "../scripts/network-retry.mts";
import { acquireCommand, classifyAcquisitionOutput } from "../scripts/network-command.mts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => {
  realClock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a temporary outage recovers, while retry exhaustion preserves its cause and attempt count", async () => {
  fakeClock();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failure = new NetworkUnavailable("upstream unavailable"),
    calls: number[] = [];
  const recovered = retryNetwork(
    "Acquire test input",
    (attempt) => {
      calls.push(attempt);
      if (attempt < 3) throw failure;
      return Promise.resolve("verified");
    },
    { attempts: 3 },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([1]);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await vi.runAllTimersAsync();
  expect(await recovered).toBe("verified");
  expect(calls).toEqual([1, 2, 3]);
  const action = vi.fn().mockRejectedValue(failure);
  const exhausted = retryNetwork("Acquire test input", action, { attempts: 3 }).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const error = await exhausted;
  assert.ok(error instanceof Error);
  expect(error.cause).toBe(failure);
  expect(error.message).toContain("after 3 attempts");
  expect(action).toHaveBeenCalledTimes(3);
});

test("cancellation interrupts backoff and prevents further acquisition", async () => {
  fakeClock();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const controller = new AbortController(),
    action = vi.fn().mockRejectedValue(new NetworkUnavailable("offline"));
  const pending = retryNetwork("Acquire input", action, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  await vi.runAllTimersAsync();
  expect(action).toHaveBeenCalledOnce();
  await expect(retryNetwork("Cancelled input", action, { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(action).toHaveBeenCalledOnce();
});

test("permanent failures are never replayed and invalid retry policies fail before work", async () => {
  const error = new AcquisitionRejected("checksum mismatch", {
      cause: Object.assign(new Error("closed verifier pipe"), { code: "EPIPE" }),
    }),
    action = vi.fn().mockRejectedValue(error);
  await expect(retryNetwork("Verify input", action)).rejects.toBe(error);
  expect(action).toHaveBeenCalledOnce();
  action.mockClear();
  for (const attempts of [0, -1, NaN, Infinity, 1.5])
    await expect(retryNetwork("Invalid policy", action, { attempts })).rejects.toThrow("attempt limit");
  expect(action).not.toHaveBeenCalled();
});

test("HTTP acquisition honors Retry-After and releases rejected response bodies", async () => {
  fakeClock();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const busy = new Response("busy", { status: 429, headers: { "retry-after": "5" } });
  const cancel = vi.spyOn(required(busy.body, "Retry response body"), "cancel");
  const fetcher = vi.fn().mockResolvedValueOnce(busy).mockResolvedValue(new Response("verified"));
  vi.stubGlobal("fetch", fetcher);
  const request = retryNetwork("Read metadata", async () => {
    try {
      return await networkResponse("https://service.example/input");
    } catch (error) {
      throw new AggregateError([new Error("Primary mirror not found"), error], "Mirrors unavailable", { cause: error });
    }
  });
  await vi.advanceTimersByTimeAsync(4999);
  expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await (await request).text()).toBe("verified");
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("authentication errors, TLS errors, and malformed responses are not availability failures", async () => {
  const denied = new Response("denied", { status: 403 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(denied));
  expect(await networkResponse("https://service.example/input")).toBe(denied);
  const tls = new TypeError("fetch failed", {
    cause: Object.assign(new Error("untrusted"), { code: "CERT_HAS_EXPIRED" }),
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(tls));
  await expect(retryNetwork("Verify service", () => networkResponse("https://service.example/input"))).rejects.toBe(
    tls,
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(transientNetworkFailure(new SyntaxError("invalid JSON"))).toBe(false);
});

test("bounded cause traversal identifies transport failures without looping on cycles", () => {
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(transientNetworkFailure(cycle)).toBe(false);
  expect(
    transientNetworkFailure(
      new AggregateError([
        cycle,
        new Error("connection", { cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }),
      ]),
    ),
  ).toBe(true);
  const now = Date.now();
  expect(retryAfterMilliseconds(new Date(now + 3000).toUTCString(), now)).toBeGreaterThan(0);
  expect(retryAfterMilliseconds("invalid", now)).toBe(0);
  expect(retryAfterMilliseconds("9999999999999999999999999", now)).toBeLessThanOrEqual(60000);
});

test("acquisition signatures distinguish transient service failures from authentication and compiler failures", () => {
  for (const text of [
    "HTTP 503",
    "Failed to fetch https://snapshot.example/tool  500 Internal Server Error",
    "connection reset by peer",
    "TLS handshake timed out",
    "temporary failure in name resolution",
  ])
    expect(classifyAcquisitionOutput(text), text).toBe(AcquisitionReason.Unavailable);
  for (const text of [
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "manifest unknown",
    "checksum mismatch",
    "compiler error: missing symbol",
  ])
    expect(classifyAcquisitionOutput(text), text).not.toBe(AcquisitionReason.Unavailable);
});

test("a real acquisition child recovers from an outage while a deterministic failure runs once", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-acquisition-"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const script = join(root, "acquire.mjs"),
      counter = join(root, "attempts");
    writeFileSync(
      script,
      `import {existsSync,readFileSync,writeFileSync} from 'node:fs'; const p=process.argv[2];const n=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(n));if(n===1){console.error(process.argv[3]);process.exitCode=1;}`,
    );
    await acquireCommand("Acquire local fixture", process.execPath, [script, counter, "HTTP 503 Service Unavailable"]);
    expect(readFileSync(counter, "utf8")).toBe("2");
    rmSync(counter);
    await expect(
      acquireCommand("Rejected local fixture", process.execPath, [script, counter, "HTTP 403 Forbidden"]),
    ).rejects.toThrow("Rejected local fixture failed");
    expect(readFileSync(counter, "utf8")).toBe("1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("response cleanup failure preserves both errors and prevents replay", async () => {
  const response = new Response("busy", { status: 503 });
  const cleanup = new Error("response could not be released");
  vi.spyOn(required(response.body, "Response body"), "cancel").mockRejectedValue(cleanup);
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  const error = await retryNetwork("Acquire metadata", () => networkResponse("https://service.example/input")).catch(
    (error: unknown) => error,
  );
  assert.ok(error instanceof AcquisitionRejected);
  expect(fetcher).toHaveBeenCalledOnce();
  assert.ok(error.cause instanceof AggregateError);
  expect(error.cause.errors).toContain(cleanup);
});

test("an exhausted inner acquisition cannot multiply a caller's retry budget", async () => {
  fakeClock();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const action = vi.fn().mockRejectedValue(new NetworkUnavailable("Unavailable proof source"));
  const result = retryNetwork("Archive acquisition", () => retryNetwork("Proof acquisition", action, { attempts: 2 }), {
    attempts: 4,
  }).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toBeInstanceOf(NetworkRetryExhausted);
  expect(action).toHaveBeenCalledTimes(2);
});

test("a caller-selected deadline cancels active acquisition with an explicit outcome", async () => {
  await expect(
    acquireCommand("Bounded acquisition", process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }),
  ).rejects.toThrow("caller-selected deadline");
  await expect(acquireCommand("Invalid acquisition", process.execPath, [], { timeoutMs: -1 })).rejects.toThrow(
    "Invalid acquisition deadline",
  );
});
