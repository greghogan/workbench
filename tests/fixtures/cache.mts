import type { LocalImageEntry, RegistryImageEntry } from "../../src/image-contract.ts";
import type { BuilderCacheEntry } from "../../src/builder-cache.ts";
export function imageEntry(
  overrides: Partial<LocalImageEntry & RegistryImageEntry> = {},
): LocalImageEntry & RegistryImageEntry {
  return {
    key: "image-fixture",
    checkout: "/project",
    profile: "native",
    reference: "example.invalid/project:fixture",
    image: "sha256:abc",
    bytes: 0,
    lock: "/cache/image.lock",
    identity: "fixture",
    catalog: "/cache/catalog",
    endpoint: "https://example.invalid",
    tags: ["fixture"],
    created: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
export function builderEntry(overrides: Partial<BuilderCacheEntry> = {}): BuilderCacheEntry {
  return { key: "builder-fixture", builder: "fixture", volumes: [], bytes: 0, ...overrides };
}
