import { afterEach, expect, test, vi } from "vitest";
import { validateHostedCI } from "../src/ci-validation.ts";
import { registryRequest } from "../src/registry-api.ts";
import { ciDestination } from "../src/ci-destinations.ts";
import { CIProvider } from "../src/ci-hosting.ts";
vi.mock("../src/ci-destinations.ts", () => ({ ciDestination: vi.fn() }));
vi.mock("../src/ci-workflows.ts", () => ({
  renderCIWorkflow: () => "stages: [check]\ncheck: {script: [true]}\n",
  renderCIPipeline: () => "stages: [check]\nchild: {script: [true]}\n",
}));
vi.mock("../src/registry-api.ts", () => ({ registryRequest: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function destination() {
  vi.mocked(ciDestination).mockReturnValue({
    remote: "gitlab",
    provider: CIProvider.GitLab,
    repository: "https://gitlab.example:8443/team/project",
    registries: {},
  });
}
test("routine validation remains local and explicitly selected server validation checks parent and child without creating pipelines", async () => {
  destination();
  await expect(validateHostedCI("/fixture", "gitlab")).resolves.toMatchObject({ scope: "local", valid: true });
  expect(registryRequest).not.toHaveBeenCalled();
  vi.mocked(registryRequest).mockResolvedValue({ valid: true, errors: [], warnings: [] });
  await expect(validateHostedCI("/fixture", "gitlab", true)).resolves.toMatchObject({
    scope: "server",
    valid: true,
    documents: [{ name: "workflow" }, { name: "pipeline" }],
  });
  expect(vi.mocked(registryRequest).mock.calls).toHaveLength(2);
  for (const [binding, endpoint, options] of vi.mocked(registryRequest).mock.calls) {
    expect(binding.host).toBe("gitlab.example:8443");
    expect(endpoint).toBe("projects/team%2Fproject/ci/lint");
    expect(options?.input).toMatchObject({ dry_run: false, include_jobs: true });
  }
});
test("server rejection names the document and useful validation error instead of reporting success", async () => {
  destination();
  vi.mocked(registryRequest).mockResolvedValue({
    valid: false,
    errors: ["job needs an unknown preparation job"],
    warnings: [],
  });
  await expect(validateHostedCI("/fixture", "gitlab", true)).rejects.toThrow(/workflow.*unknown preparation job/);
});
