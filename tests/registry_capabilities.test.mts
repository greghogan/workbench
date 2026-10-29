import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRegistryImages } from "../src/registry-images.ts";
import { registryRequest } from "../src/registry-api.ts";
import { readRegistryManagement } from "../src/registry-management-contract.ts";
vi.mock("../src/registry-api.ts", () => ({ registryRequest: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(binding: string, provider = "gitlab", repository = "harbor.example/team/project/development-native") {
  const root = mkdtempSync(join(tmpdir(), "workbench-registry-capabilities-"));
  roots.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    `schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[ci]\noperating_systems=["linux"]\n[ci.images]\nnative="native"\n[[ci.destinations]]\nremote="origin"\nprovider="${provider}"\nrepository="https://gitlab.example:8443/team/project"\n[ci.destinations.registries]\nnative=${JSON.stringify(repository)}\n${binding}\n[[development.profiles]]\nname="native"\nbuilder="native"\nworkspace="host"\ncontainer_config=".devcontainer/config.json"\n[development.profiles.offline]\nregistry=${JSON.stringify(repository)}\ninputs=["input"]\nverify=["true"]\n`,
  );
  return root;
}
test("a custom registry remains transport-only even when CI runs on GitLab", async () => {
  const root = fixture("");
  const report = await inspectRegistryImages(root);
  expect(report.entries).toEqual([]);
  expect(report.issues).toHaveLength(1);
  expect(report.issues[0]).toContain("no registry management capability");
  expect(registryRequest).not.toHaveBeenCalled();
});
test("explicit GitLab management uses its own API binding even when CI runs on another provider", async () => {
  const root = fixture(
    '[ci.registry_management."harbor.example/team/project/development-native"]\nprovider="gitlab"\nhost="registry-api.example:8443"\nproject="independent/project"',
    "github",
  );
  vi.mocked(registryRequest).mockImplementation((_binding, endpoint) =>
    Promise.resolve(
      endpoint.includes("repositories?") ? [{ id: 1, location: "harbor.example/team/project/development-native" }] : [],
    ),
  );
  const report = await inspectRegistryImages(root);
  expect(report.issues).toEqual([]);
  expect(vi.mocked(registryRequest).mock.calls[0]?.[0]).toEqual({
    provider: "gitlab",
    host: "registry-api.example:8443",
    project: "independent/project",
  });
});
test("an explicit transport-only capability overrides a known registry's management default", async () => {
  const root = fixture(
    '[ci.registry_management."ghcr.io/team/project"]\nprovider="none"',
    "github",
    "ghcr.io/team/project",
  );
  const report = await inspectRegistryImages(root);
  expect(report.issues[0]).toContain("no registry management capability");
  expect(registryRequest).not.toHaveBeenCalled();
});
test.each([
  { provider: "gitlab", host: "https://user:secret@example.test", project: "team/project" },
  { provider: "gitlab", host: "example.test" },
  { provider: "gitlab", host: "example.test", project: "../project" },
  { provider: "none", host: "example.test" },
  { provider: "unknown", host: "example.test" },
])("registry capability declarations reject malformed or ambiguous API bindings", (binding) => {
  expect(() => readRegistryManagement({ "registry.example/team/project": binding })).toThrow();
});
