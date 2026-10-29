import { afterEach, expect, test, vi } from "vitest";
import { describeError } from "../scripts/diagnostic-errors.mjs";
import { registryRequest } from "../src/registry-api.ts";
import { RegistryProvider } from "../src/registry-management-contract.ts";
import { captureOwnedChild } from "../scripts/owned-child.mjs";
vi.mock("../scripts/owned-child.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/owned-child.mjs")>()),
  captureOwnedChild: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
test("provider requests pass JSON through stdin and preserve owned cancellation", async () => {
  const controller = new AbortController(),
    finish = Promise.withResolvers<Awaited<ReturnType<typeof captureOwnedChild>>>();
  vi.mocked(captureOwnedChild).mockReturnValue(finish.promise);
  const result = registryRequest(
    { provider: RegistryProvider.GitLab, host: "gitlab.example", project: "group/project" },
    "projects/group%2Fproject/ci/lint",
    { method: "POST", input: { content: "fixture configuration" }, signal: controller.signal },
  );
  const settings = vi.mocked(captureOwnedChild).mock.calls[0]?.[2];
  expect(settings?.input).toBe(JSON.stringify({ content: "fixture configuration" }));
  expect(vi.mocked(captureOwnedChild).mock.calls[0]?.[1]).not.toContain("fixture configuration");
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  expect(settings?.signal.aborted).toBe(true);
  finish.resolve({ pid: 1, status: null, signal: "SIGINT", stdout: "", stderr: "" });
  await rejected;
});
test("query failure retains its cause and empty successful deletions need no JSON body", async () => {
  const management = { provider: RegistryProvider.GHCR, host: "github.com" } as const;
  vi.mocked(captureOwnedChild).mockResolvedValueOnce({
    pid: 1,
    status: 1,
    signal: null,
    stdout: "",
    stderr: "API access denied",
  });
  await expect(
    registryRequest(management, "fixture").catch((error: unknown) => describeError(error)),
  ).resolves.toContain("API access denied");
  vi.mocked(captureOwnedChild).mockResolvedValueOnce({ pid: 2, status: 0, signal: null, stdout: "", stderr: "" });
  await expect(registryRequest(management, "fixture", { method: "DELETE" })).resolves.toBeUndefined();
});

test("malformed API payload diagnostics exclude response contents", async () => {
  vi.mocked(captureOwnedChild).mockResolvedValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout: "PRIVATE_RESPONSE_CONTENT",
    stderr: "",
  });
  const message = await registryRequest({ provider: RegistryProvider.GHCR, host: "github.com" }, "fixture").catch(
    (error: unknown) => describeError(error),
  );
  expect(message).toContain("invalid JSON");
  expect(message).not.toContain("PRIVATE_RESPONSE_CONTENT");
});
