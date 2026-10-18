import { join } from "node:path";
import { promised } from "./fixtures/promised.mjs";
import { inspection } from "./fixtures/checks.mjs";
import { required } from "../src/invariants.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { onlineReachable, runGate } from "../src/check-gates.ts";
import { inspectChecks, listChecks, runChecks } from "../src/checks.ts";
import { validate } from "../src/validation.ts";

vi.mock("../src/checks.ts", () => ({
  inspectChecks: vi.fn<typeof import("../src/checks.ts").inspectChecks>(),
  listChecks: vi.fn<typeof import("../src/checks.ts").listChecks>(),
  runChecks: vi.fn<typeof import("../src/checks.ts").runChecks>(),
}));
vi.mock("../src/validation.ts", () => ({ validate: vi.fn<typeof import("../src/validation.ts").validate>() }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  vi.mocked(inspectChecks).mockReturnValue(inspection(["advisory"]));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test.each([200, 401, 403, 500])(
  "HTTP %s establishes connectivity without establishing check success",
  async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    await expect(onlineReachable()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.osv.dev/"),
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  },
);

test.each([
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
])("unavailable connectivity (%s) reports a skip", async (code) => {
  vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed", { cause: { code } }));
  await expect(onlineReachable()).resolves.toBe(false);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Online checks skipped"));
});

test("a bounded probe timeout permits a skip; certificate and unexpected errors fail", async () => {
  vi.mocked(fetch).mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  await expect(onlineReachable()).resolves.toBe(false);
  const certificate = new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
  vi.mocked(fetch).mockRejectedValue(certificate);
  await expect(onlineReachable()).rejects.toBe(certificate);
  vi.mocked(fetch).mockRejectedValue("unexpected");
  await expect(onlineReachable()).rejects.toBe("unexpected");
});

test("combined checks run commit first and fresh online second, propagating online failure", async () => {
  const events: string[] = [];
  vi.mocked(validate).mockImplementation(() => {
    return promised(() => {
      events.push("validate");
    });
  });
  vi.mocked(runChecks).mockImplementation(async (_root, options, validateGate) => {
    await validateGate?.();
    await promised(() => {
      events.push(required(options, "Expected fixture value: options").online ? "online" : "commit");
      if (required(options, "Expected fixture value: options").online) throw new Error("advisory finding");
    });
  });
  await expect(runGate("/project", "check", {})).rejects.toThrow("advisory finding");
  expect(events).toEqual(["validate", "commit", "validate", "online"]);
  expect(runChecks).toHaveBeenLastCalledWith(
    "/project",
    expect.objectContaining({ online: true, stage: "ci", cache: false }),
    expect.any(Function),
    undefined,
  );
});

test("the combined gate skips unavailable online checks; the push gate still requires them", async () => {
  vi.mocked(runChecks).mockResolvedValue();
  vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ENETUNREACH" } }));
  await runGate("/project", "check", {});
  expect(runChecks).toHaveBeenCalledTimes(1);
  expect(runChecks).toHaveBeenCalledWith("/project", {}, expect.any(Function), undefined);
  vi.mocked(runChecks).mockRejectedValue(new Error("network unavailable"));
  await expect(runGate("/project", "pre-push", {})).rejects.toThrow("network unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("commit failure prevents online work, while explicit stage and role selections omit the probe", async () => {
  vi.mocked(runChecks).mockRejectedValueOnce(new Error("failed offline"));
  await expect(runGate("/project", "check", {})).rejects.toThrow("failed offline");
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(runChecks).mockResolvedValue();
  for (const options of [{ stage: "ci" }, { role: ["test"] }]) await runGate("/project", "check", options);
  await runGate("/project", "pre-commit", {});
  expect(fetch).not.toHaveBeenCalled();
});

test("inspection lists both gates without execution or network access", async () => {
  await runGate("/project", "check", { list: true });
  expect(listChecks).toHaveBeenCalledTimes(2);
  await runGate("/project", "check", { list: true, json: true });
  expect(
    JSON.parse(
      String(
        required(
          vi.mocked(console.log).mock.calls.at(-1),
          "Expected fixture value: vi.mocked(console.log).mock.calls.at(-1)",
        )[0],
      ),
    ),
  ).toHaveProperty("prePush");
  expect(runChecks).not.toHaveBeenCalled();
  expect(validate).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("no online commands require no probe; malformed or unused probe settings fail before execution", async () => {
  vi.mocked(runChecks).mockResolvedValue();
  vi.mocked(inspectChecks).mockReturnValue(inspection([]));
  await runGate("/project", "check", {});
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith("No online pre-push checks are configured.");
  vi.mocked(runChecks).mockClear();
  for (const connectivityUrl of ["file:///etc/passwd", "https://user:secret@example.invalid/"]) {
    await expect(runGate("/project", "check", { connectivityUrl })).rejects.toThrow("without credentials");
  }
  await expect(
    runGate("/project", "check", { role: ["test"], connectivityUrl: "https://example.invalid/" }),
  ).rejects.toThrow("combined");
  expect(runChecks).not.toHaveBeenCalled();
});

test("public role selection never narrows the mandatory hook gates", async () => {
  for (const mode of ["pre-commit", "pre-push"] as const) {
    for (const options of [{ role: ["test"] }, { excludeRole: ["advisory"] }]) {
      await expect(runGate("/project", mode, options)).rejects.toThrow("complete configured checks");
    }
  }
  expect(runChecks).not.toHaveBeenCalled();
});

test("one external report covers both phases and survives an online failure", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const root = mkdtempSync(join(os.tmpdir(), "workbench-gate-report-"));
  try {
    vi.mocked(runChecks).mockImplementation(async (_root, options, _validate, record) => {
      await promised(() => {
        record?.({
          version: 1,
          kind: "workbench-check-run",
          id: options?.online ? "online" : "offline",
          started: "now",
          status: options?.online ? "failed" : "passed",
          checks: [],
        });
        if (options?.online) throw new Error("online cause");
      });
    });
    await expect(runGate(root, "check", { report: "result.json" })).rejects.toThrow("online cause");
    expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toMatchObject({
      version: 1,
      success: false,
      runs: [
        { id: "offline", status: "passed" },
        { id: "online", status: "failed" },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
