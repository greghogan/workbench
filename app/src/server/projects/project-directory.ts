import { projectPaths } from "../../core/projects/project-paths.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parentPort, Worker } from "node:worker_threads";
import {
  registeredProjects,
  decodeProjectRegistry,
  type RegisteredProject,
} from "../../core/projects/project-registry.js";
import { registeredProjectGroups, registeredProjectName } from "../../core/projects/project-registration.js";
import { inputStamp } from "../../core/runtime/file-identity.js";
import { userDirectory } from "../../core/storage/storage.js";
import { decodeWorkerFailure, workerFailure } from "../http/error-response.js";

export interface ProjectDirectoryView {
  projects: RegisteredProject[];
  groups: { project: RegisteredProject; worktrees: RegisteredProject[] }[];
  available: string[];
}
export function availableProjects(view: ProjectDirectoryView): RegisteredProject[] {
  const available = new Set(view.available);
  return view.projects.filter((project) => available.has(project.path));
}
export function serveProjectDirectoryWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("Project directory requires a worker port");
  let cached: { value: ProjectDirectoryView; inputs: Map<string, string> } | undefined;
  port.on("message", () => {
    try {
      if (!cached || ![...cached.inputs].every(([path, stamp]) => inputStamp(path) === stamp)) {
        const projects = registeredProjects().map((project) => ({ ...project, name: registeredProjectName(project) }));
        const paths = [
          join(userDirectory("state"), "projects.json"),
          ...projects.flatMap((project) => [
            project.path,
            join(project.path, projectPaths.projects),
            join(project.path, ".git"),
          ]),
        ];
        const groups = registeredProjectGroups(projects, (path) => {
          paths.push(path);
        });
        cached = {
          value: {
            projects,
            groups,
            available: projects
              .filter((project) => existsSync(join(project.path, projectPaths.projects)))
              .map((project) => project.path),
          },
          inputs: new Map(paths.map((path) => [path, inputStamp(path)])),
        };
      }
      port.postMessage(cached.value);
    } catch (error) {
      port.postMessage(workerFailure(error));
    }
  });
}
function decode(input: unknown): ProjectDirectoryView {
  if (
    !input ||
    typeof input !== "object" ||
    !("projects" in input) ||
    !("groups" in input) ||
    !Array.isArray(input.groups) ||
    !("available" in input) ||
    !Array.isArray(input.available) ||
    !input.available.every((path: unknown) => typeof path === "string")
  )
    throw new Error("Invalid project directory response");
  const projects = decodeProjectRegistry({ version: 1, projects: input.projects, kept: [] }).projects;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const resolve = (value: unknown): RegisteredProject => {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
      throw new Error("Invalid project directory group");
    const project = byId.get(value.id);
    if (!project) throw new Error("Unknown project directory member");
    return project;
  };
  const groups = input.groups.map((group: unknown) => {
    if (
      !group ||
      typeof group !== "object" ||
      !("project" in group) ||
      !("worktrees" in group) ||
      !Array.isArray(group.worktrees)
    )
      throw new Error("Invalid project directory group");
    return { project: resolve(group.project), worktrees: group.worktrees.map(resolve) };
  });
  const members = groups.flatMap((group) => [group.project, ...group.worktrees]).map((project) => project.id);
  if (
    members.length !== projects.length ||
    new Set(members).size !== projects.length ||
    input.available.some((path: string) => !projects.some((project) => project.path === path))
  )
    throw new Error("Invalid project directory membership");
  return { projects, groups, available: input.available };
}
/** Names and worktree grouping are acquired off the HTTP thread and coalesced across concurrent requests. */
export class ProjectDirectory {
  private worker: Worker | undefined;
  private pending: Promise<ProjectDirectoryView> | undefined;
  private settle: { resolve: (value: ProjectDirectoryView) => void; reject: (error: Error) => void } | undefined;
  private closed = false;
  constructor(private readonly bundle: string) {}
  private start(): Worker {
    const worker = new Worker(this.bundle, { workerData: { workbenchProjectDirectory: true } });
    worker.on("message", (input: unknown) => {
      if (worker !== this.worker || this.closed) return;
      try {
        if (input && typeof input === "object" && "error" in input) throw decodeWorkerFailure(input);
        this.settle?.resolve(decode(input));
      } catch (error) {
        this.settle?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.on("error", (error: Error) => {
      if (worker === this.worker) this.settle?.reject(error);
    });
    worker.on("exit", () => {
      if (worker !== this.worker) return;
      this.worker = undefined;
      this.settle?.reject(new Error("Project directory worker exited"));
    });
    return worker;
  }
  read(): Promise<ProjectDirectoryView> {
    if (this.closed) return Promise.reject(new Error("Project directory is stopping"));
    if (this.pending) return this.pending;
    const worker = (this.worker ??= this.start());
    const pending = new Promise<ProjectDirectoryView>((resolve, reject) => {
      this.settle = { resolve, reject };
      worker.postMessage(true);
    });
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) {
          this.pending = undefined;
          this.settle = undefined;
        }
      })
      .catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.settle?.reject(new Error("Project directory is stopping"));
    await this.worker?.terminate();
    this.worker = undefined;
  }
}
