import { type MaintenanceRunner, MaintenanceKind, MaintenanceState } from "./contract.mjs";
import { createHash } from "node:crypto";
import { MaintenanceJournal, withMaintenanceOperation, publishDeclarations } from "./operation.mjs";
import { maintenanceLockCommands, maintenanceLockSelection } from "./locks.mjs";
export { maintenanceLockCommands } from "./locks.mjs";
import { maintenanceTargets, developmentDiscovery, discoverMaintenance } from "./plan.mjs";
import { replaceManagedFiles } from "../managed-files.mjs";
import { mergeMavenChecksums } from "./checksums.mjs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { MaintenanceSources, metadataRequests } from "./sources.mjs";
import { record, records } from "../values.mjs";
import { applyMaintenance, readMaintenancePlan } from "./apply.mjs";
import { captureOwnedChild, processCancellation, runOwnedChild } from "../owned-child.mjs";
import { processFailure } from "../process-outcome.mjs";

export async function maintenanceMain(
  args: string[],
  root: string,
  run: MaintenanceRunner,
  signal?: AbortSignal,
): Promise<void> {
  const sources = new MaintenanceSources(metadataRequests(fetch, signal));
  const cancellation = signal ? { signal } : {};
  const program = new Command()
    .name("maintenance")
    .description(
      "Maintain this repository's development inputs; installed Workbench releases and collection pins are independent.",
    );
  program
    .command("plan")
    .option("--kind <kind...>", `Limit discovery to: ${Object.values(MaintenanceKind).join(", ")}`)
    .requiredOption("--output <path>", "Write the reviewable plan as JSON")
    .action(async (options: { kind?: string[]; output: string }) => {
      const kinds = options.kind?.map((value) => {
        const kind = Object.values(MaintenanceKind).find((kind) => value.localeCompare(kind) === 0);
        if (!kind) throw new Error(`Unknown maintenance kind: ${value}`);
        return kind;
      });
      const plan = await discoverMaintenance(root, developmentDiscovery(sources, root), {
        ...(kinds ? { kinds } : {}),
        ...cancellation,
        sources,
      });
      signal?.throwIfAborted();
      replaceManagedFiles([[resolve(options.output), `${JSON.stringify(plan, null, 2)}\n`]]);
      for (const entry of plan.entries)
        if (entry.state !== MaintenanceState.Current || entry.latest !== undefined)
          console.log(
            `${entry.state}: ${entry.path}: ${entry.name} ${entry.current}${entry.selected ? ` → ${entry.selected.version}` : ""}${entry.reason ? `; ${entry.reason}` : ""}`,
          );
      console.log(`Plan: ${resolve(options.output)}`);
    });
  program
    .command("apply")
    .argument("<plan>")
    .option("--environments", "Include explicitly requested Nix and Guix pin changes")
    .option("--refresh-locks", "Regenerate affected language locks and verification metadata after declaration edits")
    .option("--lock-scope <scope>", "Refresh changed roots or the complete selected inventory", "changed")
    .option("--resume", "Resume lock refresh from this plan's last checkpoint")
    .action(
      async (
        path: string,
        options: { environments?: boolean; refreshLocks?: boolean; lockScope: string; resume?: boolean },
      ) => {
        if (options.lockScope !== "changed" && options.lockScope !== "selected")
          throw new Error("Lock scope must be changed or selected");
        const scope = options.lockScope;
        if (options.resume && !options.refreshLocks) throw new Error("--resume requires --refresh-locks");
        await withMaintenanceOperation(
          root,
          async (operation) => {
            const plan: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
            const journal = options.refreshLocks
              ? new MaintenanceJournal(root, `${resolve(path)}.progress.json`, plan, scope, options.resume ?? false)
              : undefined;
            if (journal?.value.phase === "complete") {
              console.log("Maintenance already completed for this plan.");
              return;
            }
            const kinds = new Set(
              records(record(plan, "Invalid plan").entries, "Missing entries").map((entry) => entry.kind),
            );
            if (!options.resume) {
              const prepared = readMaintenancePlan(root, plan);
              const selected = prepared.selected.map(({ target, release }) => ({
                ...target,
                state: MaintenanceState.Available as const,
                selected: release,
              }));
              const preview = maintenanceLockSelection(
                root,
                maintenanceTargets(root).map(
                  (target) =>
                    selected.find((entry) => entry.id === target.id) ?? {
                      ...target,
                      state: MaintenanceState.Current as const,
                    },
                ),
                (scope === "selected" ? prepared.targets : selected).map((entry) => entry.path),
              );
              if (options.refreshLocks)
                console.log(
                  `Lock refresh (${scope}):\n${maintenanceLockCommands(root, preview)
                    .map((command) => JSON.stringify([command.cwd, command.command, ...command.arguments]))
                    .join("\n")}`,
                );
              await applyMaintenance(root, plan, {
                run,
                sources,
                operation,
                ...cancellation,
                ...(options.environments ? { environments: true } : {}),
                publish: (files, check) => {
                  if (journal) {
                    journal.value.changedPaths = files.map(([path]) => path);
                    journal.save();
                  }
                  publishDeclarations(root, files, check);
                  journal?.checkpoint("locks");
                },
              });
            }
            if (!journal) {
              console.log("Declarations updated; changes remain ready for verification and review.");
              return;
            }
            const inventory = maintenanceTargets(root);
            const authorities =
              scope === "selected"
                ? inventory.filter((target) => kinds.has(target.kind)).map((target) => target.path)
                : journal.value.changedPaths;
            const commands = maintenanceLockCommands(
              root,
              maintenanceLockSelection(
                root,
                inventory.map((target) => ({ ...target, state: MaintenanceState.Current as const })),
                authorities,
              ),
            );
            for (const command of commands) {
              signal?.throwIfAborted();
              const id = createHash("sha256").update(JSON.stringify(command)).digest("hex");
              if (journal.value.completed.includes(id)) continue;
              try {
                journal.verifyDeclarations();
                await run(command, operation.owner);
                if (command.checksums) {
                  const existing = (journal.value.checksums ??= {});
                  (existing[command.checksums.path] ??= {})[command.checksums.environment] = readFileSync(
                    command.checksums.path,
                    "utf8",
                  );
                  const following = commands
                    .slice(commands.indexOf(command) + 1)
                    .some((next) => next.checksums?.path === command.checksums?.path);
                  if (!following)
                    replaceManagedFiles([
                      [
                        command.checksums.path,
                        mergeMavenChecksums(Object.values(existing[command.checksums.path] ?? {})),
                      ],
                    ]);
                }
                journal.value.completed.push(id);
                journal.checkpoint("locks");
              } catch (error) {
                const failures = [error];
                try {
                  journal.checkpoint("locks");
                } catch (checkpoint) {
                  failures.push(checkpoint);
                }
                if (failures.length > 1)
                  throw new AggregateError(
                    failures,
                    "Maintenance lock refresh failed and its checkpoint could not be saved",
                    { cause: error },
                  );
                throw new Error(
                  `Maintenance lock refresh failed. Progress: ${journal.path}; rerun with --resume after reviewing the working changes.`,
                  { cause: error },
                );
              }
            }
            journal.checkpoint("complete");
            console.log(`Maintenance complete. Progress: ${journal.path}`);
          },
          signal,
        );
      },
    );
  program.command("ruby-lock", { hidden: true }).action(async () => {
    await run({
      command: process.execPath,
      arguments: [join(root, "bin/workbench.mjs"), "ruby-package-manager-exec", "--", "update"],
      cwd: process.cwd(),
      environment: { BUNDLE_FROZEN: "false" },
    });
  });
  await program.parseAsync(args, { from: "user" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cancellation = processCancellation();
  try {
    await maintenanceMain(
      process.argv.slice(2),
      resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      async (request, owner) => {
        console.error(`Running: ${request.command} ${request.arguments.join(" ")}`);
        if (!request.capture) {
          const outcome = await runOwnedChild(request.command, request.arguments, {
            cwd: request.cwd,
            env: { ...process.env, ...request.environment },
            signal: cancellation.signal,
            ...(owner ? { owner } : {}),
          });
          const failure = processFailure("maintenance command", outcome);
          if (failure) throw failure;
          return "";
        }
        const outcome = await captureOwnedChild(
          request.command,
          request.arguments,
          {
            cwd: request.cwd,
            env: { ...process.env, ...request.environment },
            signal: cancellation.signal,
            ...(owner ? { owner } : {}),
          },
          16 * 1024 * 1024,
        );
        const failure = processFailure("maintenance command", outcome, outcome);
        if (failure) throw failure;
        if (outcome.stderr) process.stderr.write(outcome.stderr);
        return outcome.stdout;
      },
      cancellation.signal,
    );
  } finally {
    cancellation.close();
  }
}
