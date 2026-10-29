import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProject, registeredProjects } from "../src/project-registry.ts";
import { refreshProjectRequirements } from "../src/project-requirements.ts";
vi.mock("../src/native-tools.ts", () => ({
  nativeInstallationPlan: (root: string) => [
    {
      root: ".",
      tool: "node",
      version: readFileSync(join(root, ".node-version"), "utf8").trim(),
      provider: "unavailable",
    },
  ],
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("staged and outgoing snapshots prove their own pins while current checkout requirements remain protected", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-proof-")));
  roots.push(base);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(base, "state"));
  const [root, snapshot] = ["current", "snapshot"].map((name) => {
    const root = join(base, name);
    mkdirSync(join(root, "workbench"), { recursive: true });
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="demo"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
    );
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
    return root;
  });
  if (!root || !snapshot) throw new Error("Missing fixtures");
  registerProject(root, "demo");
  writeFileSync(join(root, ".node-version"), "26.12.2");
  writeFileSync(join(snapshot, ".node-version"), "26.12.1");
  refreshProjectRequirements(root, { paths: ["."] }, snapshot);
  expect(registeredProjects()[0]?.requirements?.map((entry) => entry.version)).toEqual(["26.12.2"]);
  expect(registeredProjects()[0]?.working?.map((entry) => entry.version)).toEqual(["26.12.1"]);
  refreshProjectRequirements(root, { paths: ["."] });
  expect(registeredProjects()[0]?.working?.map((entry) => entry.version)).toEqual(["26.12.2"]);
});
