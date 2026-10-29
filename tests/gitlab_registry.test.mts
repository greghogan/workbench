import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  managedRegistryImages,
  RegistryProvider,
  revalidateManagedRegistryImage,
  type RegistryManagement,
} from "../src/registry-management.ts";
import { registryRequest } from "../src/registry-api.ts";
import { prunePreparedImages } from "../src/prepared-images.ts";
import { imageHash } from "../src/image-contract.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/registry-api.ts", () => ({ registryRequest: vi.fn() }));
const management = {
  provider: RegistryProvider.GitLab,
  host: "gitlab.example",
  project: "team/nested/project",
} satisfies RegistryManagement;
const repository = "registry.example/team/nested/project/development-native";
const tag = `linux-x64-${"a".repeat(64)}`;
const created = "2026-10-01T00:00:00Z";
const roots: string[] = [];
let digest: string;
let calls: string[];
beforeEach(() => {
  digest = `sha256:${"b".repeat(64)}`;
  calls = [];
  vi.mocked(registryRequest).mockImplementation((_management, endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes("/tags/")) return Promise.resolve({ name: tag, digest, created_at: created });
    if (endpoint.includes("/tags?")) return Promise.resolve([{ name: tag }, { name: "release-current" }]);
    if (endpoint.endsWith("registry/repositories?per_page=100&page=1"))
      return Promise.resolve([
        { id: 91, location: repository },
        { id: 92, location: "registry.example/unrelated/image" },
      ]);
    return Promise.reject(new Error(`Unexpected registry request: ${endpoint}`));
  });
});
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("GitLab inventory uses its configured server and nested project, selecting prepared tags only", async () => {
  const images = await managedRegistryImages(repository, management);
  expect(images).toMatchObject([{ image: digest, tags: [tag], created }]);
  expect(calls.every((endpoint) => endpoint.startsWith("projects/team%2Fnested%2Fproject/registry/repositories"))).toBe(
    true,
  );
  expect(calls.some((endpoint) => endpoint.endsWith("/release-current"))).toBe(false);
  await expect(managedRegistryImages("registry.example/other/project", management)).rejects.toThrow(/not found/);
});
test("pagination includes all repository pages and a failed page cannot produce a partial inventory", async () => {
  const original = vi.mocked(registryRequest).getMockImplementation();
  vi.mocked(registryRequest).mockImplementation((binding, endpoint, options) => {
    if (endpoint.endsWith("registry/repositories?per_page=100&page=1"))
      return Promise.resolve(
        Array.from({ length: 100 }, (_, id) => ({ id: id + 1, location: `registry.example/other/${String(id)}` })),
      );
    if (endpoint.endsWith("registry/repositories?per_page=100&page=2"))
      return Promise.resolve([{ id: 191, location: repository }]);
    if (!original) throw new Error("Missing API fixture");
    return original(binding, endpoint, options);
  });
  expect(await managedRegistryImages(repository, management)).toHaveLength(1);
  vi.mocked(registryRequest).mockRejectedValue(new Error("GitLab API: HTTP 403"));
  await expect(managedRegistryImages(repository, management)).rejects.toThrow(/HTTP 403/);
});
async function entries() {
  const root = mkdtempSync(join(tmpdir(), "workbench-registry-selection-"));
  roots.push(root);
  return (await managedRegistryImages(repository, management)).map((image) => ({
    ...image,
    management,
    key: imageHash(image.endpoint),
    checkout: root,
    profile: "native",
    reference: `${repository}:${tag}`,
    bytes: 0,
    lock: join(root, "profile.json"),
  }));
}
test("retagging invalidates the complete deletion preview before any selected tag is deleted", async () => {
  const selected = await entries();
  digest = `sha256:${"c".repeat(64)}`;
  await expect(
    revalidateManagedRegistryImage(management, selected[0]?.endpoint ?? "", selected[0]?.identity ?? ""),
  ).rejects.toThrow(/changed/);
  await expect(prunePreparedImages({ location: "registry", entries: selected, issues: [] })).rejects.toThrow(/changed/);
  expect(vi.mocked(registryRequest).mock.calls.some(([, , options]) => options?.method === "DELETE")).toBe(false);
});
test("explicit GitLab cleanup deletes only the revalidated selected tag", async () => {
  const selected = await entries();
  await prunePreparedImages({ location: "registry", entries: selected, issues: [] });
  expect(
    vi
      .mocked(registryRequest)
      .mock.calls.filter(([, , options]) => options?.method === "DELETE")
      .map(([binding, endpoint]) => [binding, endpoint]),
  ).toEqual([[management, selected[0]?.endpoint]]);
});
test("tag detail requests are bounded, cancellation stops admission, and active requests drain before rejection", async () => {
  const started = Promise.withResolvers<undefined>(),
    release = Promise.withResolvers<undefined>();
  const tags = Array.from({ length: 12 }, (_, i) => `linux-x64-${i.toString(16).padStart(64, "0")}`);
  const controller = new AbortController();
  let active = 0,
    maximum = 0,
    queried = 0;
  vi.mocked(registryRequest).mockImplementation(async (_binding, endpoint, options) => {
    if (endpoint.includes("registry/repositories?")) return [{ id: 91, location: repository }];
    if (endpoint.includes("/tags?")) return tags.map((name) => ({ name }));
    active++;
    maximum = Math.max(maximum, active);
    queried++;
    if (active === 4) started.resolve(undefined);
    try {
      await release.promise;
      options?.signal?.throwIfAborted();
      return { name: endpoint.split("/").at(-1), digest, created_at: created };
    } finally {
      active--;
    }
  });
  const result = managedRegistryImages(repository, management, controller.signal);
  const rejected = expect(result).rejects.toThrow();
  await started.promise;
  controller.abort();
  expect(active).toBe(4);
  release.resolve(undefined);
  await rejected;
  expect(maximum).toBe(4);
  expect(queried).toBe(4);
  expect(active).toBe(0);
});

test("metadata accumulation is bounded across individually valid API pages", async () => {
  vi.mocked(registryRequest).mockResolvedValue(
    Array.from({ length: 100 }, (_, id) => ({ id: id + 1, location: "other", extra: "x".repeat(10000) })),
  );
  await expect(managedRegistryImages(repository, management)).rejects.toThrow(/metadata byte budget/);
});
