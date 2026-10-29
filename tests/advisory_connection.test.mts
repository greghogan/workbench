import { fakeClock, realClock } from "./fixtures/clock.mts";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAdvisories } from "../src/advisories.ts";
import { UserFacingError, diagnosticError } from "../scripts/diagnostic-errors.mjs";
import {
  renderDiagnosticEvent,
  createDiagnosticEvent,
  LogLevel,
  LogFormat,
  DiagnosticOperation,
  DiagnosticOutcome,
} from "../scripts/diagnostics.mjs";
let root: string;
afterEach(() => {
  realClock();
  vi.unstubAllGlobals();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), "workbench-osv-connection-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), "packages:\n  package@1.0.0: {}\n");
}
const timeout = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect timeout: private diagnostic detail"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
test("transient OSV connection failures retry without treating incomplete checks as success", async () => {
  fixture();
  fakeClock();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(timeout())
    .mockResolvedValue(new Response(JSON.stringify({ results: [{}] })));
  vi.stubGlobal("fetch", fetcher);
  const result = checkAdvisories(root, "typescript");
  await vi.runAllTimersAsync();
  await result;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test("exhausted OSV connections have a readable terminal explanation and retained structured causes", async () => {
  fixture();
  fakeClock();
  const fetcher = vi.fn().mockRejectedValue(timeout());
  vi.stubGlobal("fetch", fetcher);
  const result = checkAdvisories(root, "typescript").catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const failure = await result;
  expect(failure).toBeInstanceOf(UserFacingError);
  expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  const event = createDiagnosticEvent(
    LogLevel.Error,
    DiagnosticOperation.Command,
    DiagnosticOutcome.Failed,
    { command: "advisories" },
    failure,
  );
  const text = renderDiagnosticEvent(event, LogFormat.Text);
  expect(text).toContain("Could not connect to OSV (api.osv.dev)");
  expect(text).toContain(`after ${String(fetcher.mock.calls.length)} attempts`);
  expect(text).not.toMatch(/private diagnostic|UND_ERR|\{"command"/);
  expect(renderDiagnosticEvent(event, LogFormat.Json)).toContain("UND_ERR_CONNECT_TIMEOUT");
  expect(diagnosticError(failure).causes).toHaveLength(1);
});
test("TLS verification failures fail immediately and retain their cause", async () => {
  fixture();
  const fetcher = vi.fn().mockRejectedValue(
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("Certificate is invalid"), { code: "CERT_HAS_EXPIRED" }),
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(checkAdvisories(root, "typescript")).rejects.toThrow(/Could not connect to OSV/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  [403, "denied", /rejected with HTTP 403/],
  [200, "invalid JSON", /malformed or unreadable/],
] as const)(
  "OSV response %s has a specific diagnostic without replaying permanent errors",
  async (status, body, message) => {
    fixture();
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(checkAdvisories(root, "typescript")).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

test("a disconnected OSV response body retries after releasing its reader", async () => {
  fixture();
  fakeClock();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(Buffer.from('{"results":'));
      else controller.error(Object.assign(new Error("body connection reset"), { code: "ECONNRESET" }));
    },
  });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValue(new Response('{"results":[{}]}'));
  vi.stubGlobal("fetch", fetcher);
  const result = checkAdvisories(root, "typescript").catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(body.locked).toBe(false);
});
