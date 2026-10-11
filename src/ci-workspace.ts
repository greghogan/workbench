import { materializeDistribution } from "./installation-project.js";
import { readDistributionPin } from "./distribution-manifest.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readlink, symlink, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CILifecycle, executeCI } from "./ci-lifecycle.js";
import { errorMessage, type InfrastructureError } from "../scripts/ci-results.mjs";

/** Materialize pending files and an independent index so Nix sees newly added inputs. */
export async function snapshotCIProject(
  root: string,
  destination: string,
  lifecycle?: CILifecycle,
): Promise<{ path: string; tree: string }[]> {
  const nested: { path: string; tree: string }[] = [];
  const ignored = new Set([".git"]);
  const source = await executeCI("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    capture: true,
  });
  await executeCI("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", root, destination]);
  for (const name of new Set(source.split("\0").filter(Boolean))) {
    await lifecycle?.checkpoint();
    if (name.split(/[\\/]/).some((component) => ignored.has(component))) continue;
    const path = resolve(root, name);
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const output = join(destination, name);
    await mkdir(dirname(output), { recursive: true });
    if (lstatSync(path).isSymbolicLink()) {
      await symlink(await readlink(path), output);
      continue;
    }
    if (lstatSync(path).isDirectory() && existsSync(join(path, ".git"))) {
      nested.push(
        ...(await snapshotCIProject(path, output, lifecycle)).map((entry) => ({
          ...entry,
          path: join(name, entry.path).replaceAll("\\", "/"),
        })),
      );
      continue;
    }
    await cp(path, output, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (entry) =>
        !relative(root, entry)
          .split(/[\\/]/)
          .some((component) => ignored.has(component)),
    });
  }
  await lifecycle?.checkpoint();
  if (readDistributionPin(destination)) {
    materializeDistribution(root, destination, "");
    await executeCI("git", ["add", "--force", "--", ".workbench"], { cwd: destination });
  }
  await executeCI("git", ["add", "--all"], { cwd: destination });
  return [
    { path: ".", tree: (await executeCI("git", ["write-tree"], { cwd: destination, capture: true })).trim() },
    ...nested,
  ];
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error(`${path}: local CI requires an owned private directory`);
}

/** Own only this rehearsal's disposable resources; reports and caches outlive the scope. */
export class CIWorkspace {
  readonly workspace: string;
  readonly lock: string;
  readonly temporary: string;
  readonly reports: string;
  readonly context: string;
  readonly adapter: string;
  private created = false;
  private closed = false;
  private readonly forks = new Set<string>();
  private readonly preserved = new Set<string>();

  constructor(readonly root: string) {
    const parent = join(tmpdir(), `workbench-ci-${String(process.getuid?.())}`);
    privateDirectory(parent);
    const slot = join(parent, createHash("sha256").update(resolve(root)).digest("hex").slice(0, 24));
    privateDirectory(slot);
    this.lock = join(slot, "active");
    this.workspace = join(slot, "workspace");
    try {
      mkdirSync(this.lock, { mode: 0o700 });
    } catch (error) {
      throw new Error(`Local CI workspace is busy or needs recovery: ${this.lock}`, { cause: error });
    }
    try {
      if (existsSync(this.workspace)) throw new Error(`Preserving an existing local CI workspace: ${this.workspace}`);
      this.temporary = mkdtempSync(join(tmpdir(), "workbench-ci-reports-"));
      this.reports = join(this.temporary, "reports");
      this.context = join(this.temporary, "image");
      this.adapter = join(this.temporary, "docker");
      mkdirSync(this.reports);
    } catch (error) {
      rmSync(this.lock, { recursive: true, force: true });
      throw error;
    }
  }

  async snapshot(lifecycle: CILifecycle) {
    this.created = true;
    return snapshotCIProject(this.root, this.workspace, lifecycle);
  }

  private jobPath(id: string): string {
    return join(dirname(this.workspace), "jobs", createHash("sha256").update(id).digest("hex").slice(0, 24));
  }

  async fork(id: string): Promise<string> {
    const destination = this.jobPath(id);
    if (existsSync(destination)) throw new Error(`Preserving an existing local CI job workspace: ${destination}`);
    this.forks.add(destination);
    await cp(this.workspace, destination, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    return destination;
  }

  async release(id: string): Promise<InfrastructureError[]> {
    return this.releaseWorkspace(this.jobPath(id));
  }

  private async releaseWorkspace(workspace: string): Promise<InfrastructureError[]> {
    if (!this.forks.has(workspace) || this.preserved.has(workspace)) return [];
    try {
      const containers = new Set<string>();
      for (const label of ["devcontainer.local_folder", "workbench.ci.workspace"]) {
        const found = await executeCI("docker", ["ps", "-aq", "--filter", `label=${label}=${workspace}`], {
          capture: true,
        });
        for (const container of found.trim().split("\n").filter(Boolean)) containers.add(container);
      }
      if (containers.size) await executeCI("docker", ["rm", "--force", ...containers]);
    } catch (error) {
      this.preserved.add(workspace);
      return [{ phase: "cleanup:containers", message: `${workspace}: ${errorMessage(error)}` }];
    }
    try {
      await rm(workspace, { recursive: true, force: true });
      this.forks.delete(workspace);
      return [];
    } catch (error) {
      this.preserved.add(workspace);
      return [{ phase: "cleanup:workspace", message: `${workspace}: ${errorMessage(error)}` }];
    }
  }

  async close(): Promise<InfrastructureError[]> {
    if (this.closed) return [];
    this.closed = true;
    const errors: InfrastructureError[] = [];
    const cleanup = async (phase: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        errors.push({ phase: `cleanup:${phase}`, message: errorMessage(error) });
      }
    };
    for (const fork of this.forks) errors.push(...(await this.releaseWorkspace(fork)));
    // Uncertain container or filesystem ownership keeps the source snapshot and coordinator claim reserved.
    if (this.created && !this.preserved.size)
      await cleanup("workspace", () => rm(this.workspace, { recursive: true, force: true }));
    await cleanup("adapter", () => rm(this.adapter, { force: true }));
    await cleanup("image-context", () => rm(this.context, { recursive: true, force: true }));
    if (!errors.length && !this.preserved.size)
      await cleanup("lock", () => rm(this.lock, { recursive: true, force: true }));
    return errors;
  }
}
