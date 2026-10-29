import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { executableIdentity, readExecutableIdentity } from "../src/executable-identity.ts";
import { distribution } from "./fixtures/adoption.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-executable-"));
  roots.push(root);
  return root;
}
test("executable identity reports an owned immutable source and the actual runtime", () => {
  const root = fixture(),
    repository = "https://forge.example/workbench.git",
    revision = "a".repeat(40);
  writeFileSync(join(root, "workbench-source.json"), JSON.stringify({ schema_version: 1, repository, revision }));
  expect(readExecutableIdentity(executableIdentity(root))).toEqual({
    version: 1,
    repository: `git+${repository}`,
    revision,
    directory: realpathSync(root),
    node: { executable: process.execPath, version: process.versions.node },
  });
});
test("unrecorded development sources remain explicitly unknown and malformed inspection results are rejected", () => {
  vi.stubEnv("WORKBENCH_EXECUTING_SPEC", "");
  const identity = executableIdentity(fixture());
  expect(identity.repository).toBeNull();
  expect(identity.revision).toBeNull();
  expect(readExecutableIdentity(identity)).toEqual(identity);
  for (const invalid of [
    null,
    {},
    { ...identity, version: 2 },
    { ...identity, directory: "" },
    { ...identity, node: {} },
    { ...identity, repository: "https://forge.example/workbench.git" },
  ])
    expect(() => readExecutableIdentity(invalid)).toThrow();
});
test("the public executable inspection works without initializing a project", () => {
  const root = fixture(),
    env = {
      ...process.env,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_CONFIG_HOME: join(root, "config"),
      WORKBENCH_STATE_HOME: join(root, "state"),
      WORKBENCH_EXECUTING_SPEC: "",
    };
  const result = spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), "executable", "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readExecutableIdentity(JSON.parse(result.stdout)).directory).toBe(realpathSync(distribution));
});
