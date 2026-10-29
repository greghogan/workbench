import { approveProjectRegistration } from "../src/project-admission.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  relocateProject,
  projectIdentity,
} from "../src/project-registry.ts";
import { changeTaskQueue, readTaskQueue } from "../src/task-queue.ts";
import { terminal, processInput } from "./fixtures/terminal.mjs";
import { projectToolProtection } from "../src/project-requirements.ts";
import { projectCachePlan, applyProjectCachePlan } from "../src/project-cache.ts";
import { buildPaths, prepareBuild, withBuildLock } from "../src/builds.ts";

import { acquireProcessLock } from "../src/process-lock.ts";
import { checkCoordinationDirectory } from "../src/check-coordination.ts";
import { commandAdmission, validateCommandAdmissions } from "../src/cli/commands.ts";
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
test("relocation retains registered identity and queued work, including after a later decline and reactivation", () => {
  const { root, base } = fixture();
  const original = registerProject(root, "example");
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Approved\n---\n\n# TSK-0: Preserve work\n");
  changeTaskQueue(root, { action: "add", references: ["example:TSK-0"] });
  const queue = readTaskQueue(root),
    destination = join(base, "moved");
  expect(() => {
    relocateProject(root, destination, "example");
  }).toThrow("Move the checkout first");
  renameSync(root, destination);
  relocateProject(root, destination, "example");
  expect(projectIdentity(destination)).toBe(original.id);
  expect(projectRegistration(root)).toBe(Registration.Unregistered);
  expect(projectRegistration(destination)).toBe(Registration.Registered);
  expect(readTaskQueue(destination)).toEqual(queue);
  declineProject(destination, "example");
  registerProject(destination, "example");
  expect(projectIdentity(destination)).toBe(original.id);
  expect(readTaskQueue(destination)).toEqual(queue);
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

test("registration distinguishes absent identity from local queue storage and respects filesystem path equality", () => {
  const { root, base } = fixture();
  expect(() => projectIdentity(root)).toThrow("no registration");
  const first = registerProject(root, "first");
  const alternate = join(base, "PROJECT");
  const sameDirectory = existsSync(alternate);
  if (!sameDirectory) {
    mkdirSync(join(alternate, "workbench"), { recursive: true });
    writeFileSync(join(alternate, "workbench/projects.toml"), '[[project]]\nid="other"\npath="."\n');
  }
  const second = registerProject(alternate, "second");
  expect(second.id === first.id).toBe(sameDirectory);
  expect(registeredProjects()).toHaveLength(sameDirectory ? 1 : 2);
});

test("nested commands inherit execution policy while inspection keeps explicit exceptions", () => {
  for (const path of ["tools maven prepare", "tools maven accept", "ci run", "ci pipeline", "experiment finish"])
    expect(commandAdmission(path)).toMatchObject({ project: true, registration: true, policy: true });
  for (const path of ["check matrix", "ci validate", "experiment show", "tools profiles", "development profiles"])
    expect(commandAdmission(path).policy).toBe(false);
  expect(commandAdmission("commit check")).toMatchObject({ project: false, registration: false, policy: true });
});

test("command registration rejects stale nested overrides and unclassified execution branches", async () => {
  const { Command } = await import("commander");
  const incomplete = new Command();
  incomplete.command("tools").command("profiles");
  expect(() => {
    validateCommandAdmissions(incomplete);
  }).toThrow(/stale.*tools install/);
  const expanded = new Command(),
    tools = expanded.command("tools");
  tools.command("profiles");
  tools.command("install");
  tools.command("maven").command("prepare");
  tools.command("unclassified");
  expect(() => {
    validateCommandAdmissions(expanded);
  }).toThrow(/missing nested.*tools unclassified/);
  const existing = new Command(),
    known = existing.command("tools");
  known.command("profiles");
  known.command("install");
  known.command("maven").command("prepare");
  expect(() => {
    validateCommandAdmissions(existing);
  }).not.toThrow();
});
