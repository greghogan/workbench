import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { applyProjectCachePlan, projectCachePlan } from "../core/projects/project-cache.js";
import {
  registerConsumingProject,
  registeredProjectName,
  relocateConsumingProject,
} from "../core/projects/project-registration.js";
import { recoverProjectRegistry, registeredProjects } from "../core/projects/project-registry.js";
import { formatBytes } from "../core/runtime/byte-size.js";
import { processCancellation } from "../core/runtime/owned-child.mjs";
import { registerCommand } from "./commands.js";
import { resolve } from "node:path";
import { distributionRoot } from "../core/projects/project-context.js";
import { npmWorkbench } from "../core/distribution/launcher-acquisition.js";
import { archiveInstallationEnvironment } from "../core/distribution/distribution-identity.js";
import { executingToolPin, readToolPin } from "../core/distribution/launcher-identity.js";
import { sameToolPin, toolSpecification } from "../core/toolchains/tool-pin.js";

export function registerProjectCommands(program: Command): void {
  const project = registerCommand(program, "project")
    .description("List and manage consuming projects")
    .option("--json", "Print the project index as JSON")
    .action((options: { json?: boolean }) => {
      const projects = registeredProjects().map((project) => ({ ...project, name: registeredProjectName(project) }));
      if (options.json) console.log(JSON.stringify(projects, null, 2));
      else for (const entry of projects) console.log(`${entry.name}: ${entry.path}`);
    });
  project
    .command("add")
    .description("Register an existing Workbench checkout without changing its files")
    .argument("<path>", "Workbench project directory")
    .action(async (path: string) => {
      const cancellation = processCancellation();
      try {
        await registerConsumingProject(path, cancellation.signal);
        const directory = resolve(path),
          selected = process.env[archiveInstallationEnvironment] ? undefined : readToolPin(directory),
          distribution = distributionRoot(directory),
          executing = executingToolPin(distribution);
        if (selected && (!executing || !sameToolPin(selected, executing))) {
          await npmWorkbench(
            toolSpecification(selected),
            ["registration-check"],
            directory,
            { ...process.env, WORKBENCH_PROJECT_ROOT: directory },
            distribution,
          );
          if (process.exitCode)
            throw new Error(
              "Registration was saved, but the project's selected Workbench release could not verify it. Update the executable pin or use a matching installed release before retrying; project files are unchanged.",
            );
        }
        console.log(`Registered ${path}.`);
      } finally {
        cancellation.close();
      }
    });
  project
    .command("relocate")
    .description("Update registration after moving a checkout, preserving its identity and local task queue")
    .argument("<previous-path>", "Previous checkout directory, which must now be absent")
    .argument("<path>", "Moved Workbench checkout")
    .action(async (previous: string, path: string) => {
      const cancellation = processCancellation();
      try {
        await relocateConsumingProject(previous, path, cancellation.signal);
        console.log(`Updated project location to ${path}.`);
      } finally {
        cancellation.close();
      }
    });
  project
    .command("recover")
    .description("Release a registry metadata lock only when its local writer is provably gone")
    .action(() => {
      recoverProjectRegistry();
      console.log("Abandoned registry lock recovered.");
    });
  project
    .command("remove")
    .description("Verify and remove owned project caches, then remove registration")
    .argument("<path>", "Project directory, including a missing checkout")
    .option("--json", "Print the reviewed removal plan")
    .option("--apply", "Apply removal after reviewing the plan")
    .option("--digest <sha256>", "Exact digest of the reviewed removal plan")
    .action(async (path: string, options: { json?: boolean; apply?: boolean; digest?: string }) => {
      const plan = await projectCachePlan(path);
      if (options.json && !options.apply) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      if (!options.json) {
        console.log(
          `Remove ${JSON.stringify(plan.project)} from registered projects and delete ${formatBytes(plan.bytes)} of owned caches.`,
        );
        console.log(`Review SHA-256: ${plan.digest}`);
        for (const report of plan.reports) {
          for (const entry of report.entries)
            console.log(`Cache: ${JSON.stringify(entry.directory)} (${formatBytes(entry.bytes)})`);
          for (const entry of report.builders?.entries ?? []) console.log(`Builder: ${JSON.stringify(entry.key)}`);
          for (const entry of report.images?.entries ?? []) console.log(`Image: ${JSON.stringify(entry.reference)}`);
        }
        for (const reason of plan.blocked) console.log(`Retained: ${JSON.stringify(reason)}`);
      }
      let apply = options.apply === true;
      if (apply && options.digest !== plan.digest)
        throw new Error("Supply --digest with the reviewed plan's exact SHA-256");
      if (!apply && process.stdin.isTTY && process.stdout.isTTY) {
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try {
          apply = /^y(?:es)?$/i.test(
            (await input.question("Delete these caches and remove registration? [y/N] ")).trim(),
          );
        } finally {
          input.close();
        }
      }
      if (!apply) {
        console.log("Preview only. Use --apply --digest SHA256 after review. Project files are preserved.");
        return;
      }
      await applyProjectCachePlan(plan, true);
      if (options.json)
        console.log(JSON.stringify({ applied: true, project: plan.project, digest: plan.digest }, null, 2));
      else console.log("Owned caches removed and registration declined. Project files are preserved.");
    });
}
