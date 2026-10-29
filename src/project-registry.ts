import { record } from "../scripts/values.mjs";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { userDirectory } from "./storage.js";
import { withCacheLockSync, withCacheLock, recoverCacheMetadataLock } from "./cache-lock.js";
import { isToolRequirement, type ToolRequirement } from "./tool-requirements.js";
import { StateConflict, InvalidInput } from "./input-errors.js";
import { BoundedState } from "./bounded-state.js";

export const Registration = { Unregistered: "unregistered", Registered: "registered", Declined: "declined" } as const;
export type Registration = (typeof Registration)[keyof typeof Registration];
export interface ProjectRequirement extends ToolRequirement {
  root: string;
  profile: string;
}
export interface RegisteredProject {
  id: string;
  path: string;
  name: string;
  state: Exclude<Registration, "unregistered">;
  updated: string;
  requirements?: ProjectRequirement[];
  working?: ProjectRequirement[];
  requirementError?: string;
  queueKey?: string;
}
interface Registry {
  version: 1;
  projects: RegisteredProject[];
  kept: string[];
}
const path = () => join(userDirectory("state"), "projects.json");
const lock = () => join(userDirectory("state"), "project-registry");
export function canonicalProject(directory: string): string {
  const absolute = resolve(directory);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}
/** Apply the same filesystem comparison rule to lookup, uniqueness, and storage keys. */
export function projectPathComparison(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
export function projectPathKey(directory: string): string {
  return createHash("sha256")
    .update(projectPathComparison(canonicalProject(directory)))
    .digest("hex")
    .slice(0, 24);
}
/** Only a registration gives a project a durable identity. */
export function projectIdentity(directory: string): string {
  const project = projectRegistrySnapshot().atPath(directory);
  if (!project) throw new InvalidInput("Project has no registration; use workbench project add");
  return project.id;
}
/** Local queues may exist before registration; their storage key is independent of the public identity. */
export function projectQueueKey(directory: string): string {
  return projectRegistrySnapshot().atPath(directory)?.queueKey ?? projectPathKey(directory);
}
export function decodeProjectRegistry(input: unknown): Registry {
  const value = record(input, "Invalid project registry");
  const requirements = (entries: unknown) =>
    entries === undefined ||
    (Array.isArray(entries) &&
      entries.every(
        (entry: unknown) =>
          isToolRequirement(entry) &&
          "root" in entry &&
          typeof entry.root === "string" &&
          "profile" in entry &&
          typeof entry.profile === "string",
      ));
  if (
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.kept) ||
    !value.kept.every((entry) => typeof entry === "string" && isAbsolute(entry)) ||
    !value.projects.every((input: unknown) => {
      const project = record(input, "Invalid project registry");
      return (
        typeof project.id === "string" &&
        /^[a-f0-9]{24}$/.test(project.id) &&
        typeof project.path === "string" &&
        isAbsolute(project.path) &&
        typeof project.name === "string" &&
        (project.state === Registration.Registered || project.state === Registration.Declined) &&
        typeof project.updated === "string" &&
        Number.isFinite(Date.parse(project.updated)) &&
        requirements(project.requirements) &&
        requirements(project.working) &&
        (project.requirementError === undefined || typeof project.requirementError === "string") &&
        (project.queueKey === undefined ||
          (typeof project.queueKey === "string" && /^[a-f0-9]{24}$/.test(project.queueKey)))
      );
    }) ||
    new Set(value.projects.map((input: unknown) => record(input, "Invalid project registry").id)).size !==
      value.projects.length ||
    new Set(
      value.projects.map((input: unknown) =>
        projectPathComparison(String(record(input, "Invalid project registry").path)),
      ),
    ).size !== value.projects.length
  )
    throw new Error("Invalid project registry");
  return value as unknown as Registry;
}
const store = new BoundedState<Registry>(path, 16 * 1024 * 1024, decodeProjectRegistry, () => ({
  version: 1,
  projects: [],
  kept: [],
}));
const transaction = new AsyncLocalStorage<Registry>();
const read = () => transaction.getStore() ?? store.read();
function edit(update: (registry: Registry) => void): void {
  const active = transaction.getStore();
  if (active) {
    update(active);
    return;
  }
  withCacheLockSync(lock(), () => {
    const registry = read();
    update(registry);
    store.write(registry);
  });
}
/** A cancelled waiter writes nothing. Once admitted, one validated atomic write completes the transaction. */
export async function withProjectRegistryWrite<T>(action: () => T, signal?: AbortSignal): Promise<T> {
  return withCacheLock(
    lock(),
    () => {
      const registry = store.read();
      const result = transaction.run(registry, action);
      if (result instanceof Promise) throw new Error("Registry transactions require a synchronous mutation");
      store.write(registry);
      return Promise.resolve(result);
    },
    undefined,
    signal,
  );
}
export function recoverProjectRegistry(): void {
  recoverCacheMetadataLock(lock());
}
export function registeredProjects(includeDeclined = false): RegisteredProject[] {
  return read().projects.filter((project) => includeDeclined || project.state === Registration.Registered);
}
export function projectRegistration(directory: string): Registration {
  const root = canonicalProject(directory);
  return (
    read().projects.find((project) => projectPathComparison(project.path) === projectPathComparison(root))?.state ??
    Registration.Unregistered
  );
}
/** One indexed immutable read belongs to one operation, never to the process lifetime. */
export function projectRegistrySnapshot() {
  const value = read();
  const byPath = new Map(value.projects.map((project) => [projectPathComparison(project.path), project]));
  return {
    projects: value.projects.filter((project) => project.state === Registration.Registered),
    byId: new Map(value.projects.map((project) => [project.id, project])),
    atPath: (directory: string) => byPath.get(projectPathComparison(canonicalProject(directory))),
    kept: new Set(value.kept),
  };
}
export function registerProject(directory: string, name: string): RegisteredProject {
  const root = canonicalProject(directory);
  if (!existsSync(join(root, "workbench/projects.toml")) || !lstatSync(root).isDirectory())
    throw new InvalidInput(`${root}: select an existing Workbench project`);
  let result: RegisteredProject | undefined;
  edit((registry) => {
    const previous = registry.projects.find(
      (project) => projectPathComparison(project.path) === projectPathComparison(root),
    );
    const id = previous?.id ?? randomBytes(12).toString("hex");
    result = { ...previous, id, path: root, name, state: Registration.Registered, updated: new Date().toISOString() };
    registry.projects = [...registry.projects.filter((project) => project.id !== id), result];
  });
  if (!result) throw new Error("Project registration failed");
  return result;
}
export function declineProject(directory: string, name: string, expected?: string): void {
  const root = canonicalProject(directory);
  edit((registry) => {
    const previous = registry.projects.find(
      (project) => projectPathComparison(project.path) === projectPathComparison(root),
    );
    const id = previous?.id ?? randomBytes(12).toString("hex");
    if (
      expected !== undefined &&
      JSON.stringify(registry.projects.find((project) => project.id === id) ?? null) !== expected
    )
      throw new StateConflict("Project registration changed; inspect a fresh removal plan");
    registry.projects = [
      ...registry.projects.filter((project) => project.id !== id),
      {
        id,
        path: root,
        name,
        state: Registration.Declined,
        updated: new Date().toISOString(),
        ...(previous?.queueKey ? { queueKey: previous.queueKey } : {}),
      },
    ];
  });
}
export function updateProjectRequirements(
  directory: string,
  requirements: ProjectRequirement[],
  error = "",
  working?: ProjectRequirement[],
): void {
  const root = canonicalProject(directory);
  edit((registry) => {
    const project = registry.projects.find(
      (entry) =>
        projectPathComparison(entry.path) === projectPathComparison(root) && entry.state === Registration.Registered,
    );
    if (!project) return;
    project.requirements = requirements;
    project.requirementError = error;
    const key = (entry: ProjectRequirement) => JSON.stringify([entry.root, entry.profile, entry.tool]);
    const declared = new Set(requirements.map(key));
    if (!error && project.working) project.working = project.working.filter((entry) => declared.has(key(entry)));
    if (working) {
      const replacements = new Set(working.map(key));
      project.working = [
        ...(project.working ?? []).filter((entry) => declared.has(key(entry)) && !replacements.has(key(entry))),
        ...working,
      ];
    }
    project.updated = new Date().toISOString();
  });
}
/** Update a moved checkout's location without transferring another live checkout's identity or caches. */
export function relocateProject(previousDirectory: string, directory: string, name: string): void {
  const previous = canonicalProject(previousDirectory),
    root = canonicalProject(directory);
  if (projectPathComparison(previous) === projectPathComparison(root) || existsSync(previous))
    throw new InvalidInput("Move the checkout first; its previous directory must be absent");
  if (!existsSync(join(root, "workbench/projects.toml")) || !lstatSync(root).isDirectory())
    throw new InvalidInput(`${root}: select an existing Workbench project`);
  edit((registry) => {
    const project = registry.projects.find(
      (entry) =>
        projectPathComparison(entry.path) === projectPathComparison(previous) &&
        entry.state === Registration.Registered,
    );
    if (!project) throw new InvalidInput("The previous directory is not a registered project");
    if (registry.projects.some((entry) => projectPathComparison(entry.path) === projectPathComparison(root)))
      throw new StateConflict("The destination already has its own registration");
    project.queueKey ??= projectPathKey(previous);
    project.path = root;
    project.name = name;
    project.updated = new Date().toISOString();
    delete project.working;
    project.requirementError = "Requirements must be refreshed after relocation";
  });
}
export function keptCacheAssets(): Set<string> {
  return new Set(read().kept);
}
export function keepCacheAsset(identity: string, keep: boolean): void {
  edit((registry) => {
    registry.kept = [...new Set([...registry.kept.filter((entry) => entry !== identity), ...(keep ? [identity] : [])])];
  });
}
