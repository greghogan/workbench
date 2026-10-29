import { approveProjectRegistration } from "../src/project-admission.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import {
  Registration,
  registerProject,
  projectRegistration,
  registeredProjects,
  declineProject,
  updateProjectRequirements,
  keepCacheAsset,
} from "../src/project-registry.ts";
import { terminal, processInput } from "./fixtures/terminal.mjs";
import { projectToolProtection } from "../src/project-requirements.ts";
import { projectCachePlan, applyProjectCachePlan } from "../src/project-cache.ts";
import { buildPaths, prepareBuild, withBuildLock } from "../src/builds.ts";

import { acquireProcessLock } from "../src/process-lock.ts";
import { checkCoordinationDirectory } from "../src/check-coordination.ts";
import { commandAdmission } from "../src/cli-internal.ts";
const roots: string[] = [];
const distribution = realpathSync(join(import.meta.dirname, ".."));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("interactive registration remembers a decline and accepts explicit human confirmation", async () => {
  const { root } = fixture(),
    t = terminal();
  vi.spyOn(process, "stdin", "get").mockReturnValue(processInput(t.input));
  vi.spyOn(process, "stderr", "get").mockReturnValue(t.output as unknown as typeof process.stderr);
  const declined = approveProjectRegistration(root);
  const rejection = expect(declined).rejects.toThrow("workbench project add");
  t.input.write("n\n");
  await rejection;
  const output = t.text();
  await expect(approveProjectRegistration(root)).rejects.toThrow("workbench project add");
  expect(t.text()).toBe(output);
  const other = join(root, "other");
  mkdirSync(join(other, "workbench"), { recursive: true });
  writeFileSync(join(other, "workbench/projects.toml"), '[[project]]\nid="other"\npath="."\n');
  const accepted = approveProjectRegistration(other);
  t.input.write("yes\n");
  await accepted;
  expect(projectRegistration(other)).toBe(Registration.Registered);
  t.input.destroy();
  t.output.destroy();
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-registry-")));
  roots.push(base);
  for (const kind of ["STATE", "CACHE", "CONFIG", "DATA"]) vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(base, kind));
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = join(base, "project");
  mkdirSync(join(root, "workbench"), { recursive: true });
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="example"\npath="."\n');
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  return { base, root };
}
test("registration is explicit, canonical, idempotent, and preserves last-working requirements", () => {
  const { root } = fixture();
  expect(projectRegistration(root)).toBe(Registration.Unregistered);
  const first = registerProject(root, "example");
  registerProject(join(root, "."), "example");
  expect(registeredProjects()).toHaveLength(1);
  const tool = { tool: "node", version: "26.12.1", root: ".", profile: "" };
  updateProjectRequirements(root, [tool], "", [tool]);
  updateProjectRequirements(root, [{ ...tool, version: "26.12.2" }]);
  expect(registeredProjects()[0]?.working).toEqual([tool]);
  declineProject(root, "example");
  expect(registeredProjects()).toEqual([]);
  expect(projectRegistration(root)).toBe(Registration.Declined);
  expect(registerProject(root, "example").id).toBe(first.id);
});
test("noninteractive project operations require registration and declined help gives a stderr reminder", () => {
  const { root } = fixture();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd: root,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
      encoding: "utf8",
    });
  const unknown = run("validate");
  expect(unknown.status).not.toBe(0);
  expect(unknown.stderr).toContain("workbench project add");
  expect(projectRegistration(root)).toBe(Registration.Unregistered);
  declineProject(root, "example");
  const help = run("--help");
  expect(help.status).toBe(0);
  expect(help.stderr).toContain("workbench project add");
  expect(help.stdout).not.toContain("Project is not registered");
  const add = run("project", "add", root);
  expect(add.status, add.stderr).toBe(0);
  expect(projectRegistration(root)).toBe(Registration.Registered);
});
test("reviewed removal deletes owned caches and preserves source; stale registration invalidates review", async () => {
  const { root } = fixture();
  registerProject(root, "example");
  const paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  writeFileSync(join(paths.directory, "output"), "disposable");
  const stale = await projectCachePlan(root);
  registerProject(root, "renamed");
  await expect(applyProjectCachePlan(stale, true)).rejects.toThrow(/changed/);
  expect(existsSync(paths.directory)).toBe(true);
  const current = await projectCachePlan(root);
  expect(current.bytes).toBeGreaterThan(0);
  await applyProjectCachePlan(current, true);
  expect(existsSync(paths.directory)).toBe(false);
  expect(readFileSync(join(root, "workbench/projects.toml"), "utf8")).toContain("example");
  expect(projectRegistration(root)).toBe(Registration.Declined);
});
test("active builds and explicit keeps block project removal without losing registration", async () => {
  const { root } = fixture();
  registerProject(root, "example");
  const paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  keepCacheAsset(paths.directory, true);
  await expect(applyProjectCachePlan(await projectCachePlan(root), true)).rejects.toThrow(/blocked/);
  keepCacheAsset(paths.directory, false);
  await withBuildLock(paths, async () => {
    await expect(applyProjectCachePlan(await projectCachePlan(root), true)).rejects.toThrow(/blocked|remain/);
  });
  expect(projectRegistration(root)).toBe(Registration.Registered);
});
test("a gate without cache products blocks removal; public checks retain registration admission", async () => {
  const { root } = fixture();
  registerProject(root, "example");
  const owner = acquireProcessLock(checkCoordinationDirectory(root));
  expect(owner).toBeDefined();
  try {
    await expect(applyProjectCachePlan(await projectCachePlan(root), true)).rejects.toThrow(/active|recovery/);
  } finally {
    owner?.release();
  }
  expect(projectRegistration(root)).toBe(Registration.Registered);
  expect(commandAdmission("check").internal).toBe(false);
  expect(commandAdmission("ci").internal).toBe(false);
});
test("missing registered projects protect shared tools and malformed durable state fails closed", () => {
  const { root, base } = fixture();
  registerProject(root, "example");
  rmSync(root, { recursive: true });
  expect(
    projectToolProtection({ provider: "rustup", tool: "rust", version: "1.99.1", directory: join(base, "tool") }),
  ).toEqual([`requirements unavailable: ${root}`]);
  writeFileSync(join(base, "STATE/projects.json"), JSON.stringify({ version: 1, projects: [null], kept: [] }));
  expect(() => registeredProjects()).toThrow("Invalid project registry");
});
