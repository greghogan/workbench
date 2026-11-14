import { cancelPlan, deletePlan, planDeletion } from "../core/tasks/planning/plan-disposition.js";
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { lstatSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { readGitObjects } from "../core/git/git-snapshot.js";
import { readPlanOperations } from "../core/tasks/planning/plan-operation-store.js";
import { renamePlan, resumePlanRename } from "../core/tasks/planning/plan-rename.js";
import { resumePlanTransfer } from "../core/tasks/planning/plan-transfer.js";
import { finishPlanTransfers } from "../core/tasks/planning/plan-retirement.js";
import { createPatch } from "diff";
import { readBoundedFile } from "../core/runtime/file-reads.js";
import { InvalidInput } from "../core/runtime/input-errors.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { safeOutput } from "../core/diagnostics/terminal-output.js";
import { planningRecord } from "../core/tasks/planning/planning-read-model.js";
import {
  planningPaths,
  planIdentity,
  parsePlanReference,
  type PlanIdentity,
} from "../core/tasks/planning/plan-model.js";
import {
  planningScopes,
  planningSettings,
  readPlan,
  readPlans,
  type PlanView,
} from "../core/tasks/planning/planning-store.js";
import {
  planningOperation,
  approvePlanDraft,
  checkpointPlans,
  configurePlanning,
  disablePlanning,
  recoverPlanningCheckpoint,
  resolvePlanDraft,
  savePlanDraft,
} from "../core/tasks/planning/planning-operations.js";
import { terminalAvailable } from "./terminal/terminal-choice.js";

interface PlanOptions {
  json?: boolean;
  project?: string;
}
export function resolvePlanIdentity(root: string, value: string, project?: string): PlanIdentity {
  if (value.includes(":")) {
    const result = parsePlanReference(value);
    if (project && result.scope !== project) throw new InvalidInput("Plan conflicts with the selected project scope");
    return result;
  }
  const scopes = planningScopes(root),
    scope = project ?? scopes[0]?.id;
  if (!scope || !scopes.some((candidate) => candidate.id === scope)) throw new InvalidInput("Select a project scope");
  return planIdentity(scope, value.startsWith("plan/") ? value.slice(5) : value);
}
export function registerTaskPlanCommands(tasks: Command, root: string): void {
  const plans = tasks.command("plan").description("Edit future plans and checkpoint their independent Git history");
  const identity = (value: string, command: Command) =>
    resolvePlanIdentity(root, value, command.optsWithGlobals<PlanOptions>().project);
  const show = (view: PlanView, command: Command) => {
    if (command.optsWithGlobals<PlanOptions>().json)
      console.log(
        JSON.stringify(
          {
            reference: view.reference,
            digest: view.digest,
            title: view.document?.title ?? view.name,
            contents: view.contents,
            status: view.document?.metadata.status,
            added_at: view.document?.metadata.added_at,
            draft: view.draft,
            conflict: view.conflict,
            problem: view.problem,
            approval: view.approval ? { at: view.approval.at, current: view.approval.current } : undefined,
            files: [...view.entries.keys()].filter((path) => path.startsWith(planningPaths.files)),
          },
          null,
          2,
        ),
      );
    else console.log(safeOutput(view.contents));
  };
  const files = (view: PlanView) => {
    const model = planningRecord(view);
    const rows = [
      ...model.files.map((file) => [
        file.name,
        model.changedFiles.find((change) => change.name === file.name)?.change ?? "Unchanged",
      ]),
      ...model.changedFiles.filter((file) => file.change === "removed").map((file) => [file.name, "Removed"]),
    ];
    if (rows.length) console.log(terminalTable(["SUPPORTING FILE", "CHANGE"], rows));
  };
  plans.action((_options: unknown, command: Command) => {
    const scope = command.optsWithGlobals<PlanOptions>().project,
      views = readPlans(root).filter((plan) => !scope || plan.scope === scope);
    if (command.optsWithGlobals<PlanOptions>().json)
      console.log(
        JSON.stringify(
          views.map((plan) => ({
            reference: plan.reference,
            title: plan.document?.title ?? plan.name,
            status: plan.document?.metadata.status,
            added_at: plan.document?.metadata.added_at,
            digest: plan.digest,
            draft: plan.draft,
            conflict: plan.conflict,
            problem: plan.problem,
          })),
          null,
          2,
        ),
      );
    else
      console.log(
        terminalTable(
          ["PLAN", "STATE", "TITLE", "ADDED", "STATUS"],
          views.map((view) => [
            view.reference,
            view.document?.metadata.status ?? "Draft",
            view.document?.title ?? view.name,
            view.document?.metadata.added_at?.slice(0, 10) ?? "Unknown",
            view.problem ??
              (view.conflict ? "Concurrent edits need resolution" : view.draft ? "Local draft" : "Checkpointed"),
          ]),
        ),
      );
  });
  plans
    .command("configure")
    .description("Inspect or select repository-local planning storage")
    .option("--disable", "Disable empty planning storage without removing remote history")
    .option("--branch <name>", "Use an independent planning branch (suggested: workbench/plans)")
    .option("--remote <name>", "Select the remote used for manual planning pushes")
    .option("--destination <branch>", "Select the exact remote planning branch")
    .option("--no-auto-prune", "Retain the planning branch when all work is finished")
    .action(
      (options: { disable?: boolean; branch?: string; remote?: string; destination?: string; autoPrune?: boolean }) => {
        if (options.disable) {
          if (options.branch || options.remote || options.destination || options.autoPrune === false)
            throw new InvalidInput("Use --disable without other planning selections");
          disablePlanning(root);
        } else if (options.branch)
          configurePlanning(root, {
            branch: options.branch,
            ...(options.remote ? { remote: options.remote } : {}),
            ...(options.destination ? { remote_branch: options.destination } : {}),
            auto_prune: options.autoPrune !== false,
          });
        else if (options.remote || options.destination || options.autoPrune === false)
          throw new InvalidInput("Select the planning branch with these settings");
        console.log(JSON.stringify(planningSettings(root), null, 2));
      },
    );
  plans
    .command("show")
    .description("Read a named plan or its diff since approval")
    .argument("<name>")
    .option("--diff", "Show changes since the retained approval")
    .option("--file <path>", "Read a supporting file")
    .option("--approved", "Read the retained approved version")
    .option("--output <path>", "Save exact contents to a new file")
    .action(
      (
        value: string,
        options: { diff?: boolean; file?: string; approved?: boolean; output?: string },
        command: Command,
      ) => {
        const view = readPlan(root, identity(value, command));
        if (options.diff && (options.file || options.approved || options.output))
          throw new InvalidInput("Select the plan diff or an individual version");
        if (options.file || options.approved || options.output) {
          const entries = options.approved ? view.approval?.entries : view.entries;
          if (!entries) throw new InvalidInput("This plan has not been approved");
          const path = options.file ? planningPaths.files + options.file : planningPaths.document,
            entry = entries.get(path);
          if (!entry) throw new InvalidInput("Supporting file not found");
          const bytes = readGitObjects(root, [entry.oid], 8 * 1024 * 1024).get(entry.oid);
          if (!bytes) throw new InvalidInput("Plan contents are unavailable");
          if (options.output) {
            writeFileSync(options.output, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o700 : 0o600 });
            console.log(
              command.optsWithGlobals<PlanOptions>().json
                ? JSON.stringify({ reference: view.reference, output: options.output, bytes: bytes.length })
                : `Saved ${safeOutput(options.output)}`,
            );
          } else if (command.optsWithGlobals<PlanOptions>().json)
            console.log(
              JSON.stringify({
                reference: view.reference,
                path,
                encoding: "base64",
                contents: bytes.toString("base64"),
                executable: entry.mode === "100755",
              }),
            );
          else {
            const text = bytes.toString();
            if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
              throw new InvalidInput("Use --output or --json to read binary supporting files");
            console.log(safeOutput(text));
          }
          return;
        }
        if (options.diff) {
          if (!view.approval) throw new InvalidInput("This plan has not been approved");
          console.log(safeOutput(createPatch(view.reference, view.approval.contents, view.contents)));
          files(view);
        } else show(view, command);
      },
    );
  plans
    .command("create")
    .description("Create a durable named draft without committing it")
    .argument("<name>")
    .option("--file <path>", "Read the initial Markdown plan")
    .action((value: string, options: { file?: string }, command: Command) => {
      const selected = identity(value, command),
        contents = options.file
          ? readBoundedFile(options.file, 2 * 1024 * 1024, "plan").toString()
          : `---\nstatus: Planned\n---\n\n# ${selected.name}\n`;
      show(savePlanDraft(root, selected, contents), command);
    });
  for (const resolve of [false, true])
    plans
      .command(resolve ? "resolve" : "save")
      .description(
        resolve
          ? "Save the explicitly reconciled draft and branch edits"
          : "Save a durable local plan edit without committing it",
      )
      .argument("<name>")
      .requiredOption("--file <path>", "Read the revised Markdown plan")
      .requiredOption("--expected <digest>", "Version obtained when inspecting the plan")
      .action((value: string, options: { file: string; expected: string }, command: Command) => {
        const selected = identity(value, command),
          contents = readBoundedFile(options.file, 2 * 1024 * 1024, "plan").toString();
        show(
          resolve
            ? resolvePlanDraft(root, selected, contents, options.expected)
            : savePlanDraft(root, selected, contents, { expected: options.expected }),
          command,
        );
      });
  plans
    .command("checkpoint")
    .description("Commit selected drafts together; omit names for all drafts")
    .argument("[names...]")
    .option("-m, --message <text>", "Checkpoint commit message")
    .action((values: string[], options: { message?: string }, command: Command) => {
      const revision = checkpointPlans(
        root,
        values.length ? values.map((value) => identity(value, command)) : undefined,
        options,
      );
      console.log(revision ? `Planning checkpoint: ${revision}` : "No planning checkpoint needed.");
    });
  plans
    .command("recover")
    .description("Finish interrupted plan transfers, renames, or checkpoints")
    .action(() => {
      const pending = planningOperation(root);
      if (pending && !pending.completed) console.log(`Planning checkpoint: ${recoverPlanningCheckpoint(root)}`);
      for (const stored of readPlanOperations(root).filter((entry) => !entry.operation.completed))
        console.log(
          stored.operation.kind === "rename"
            ? resumePlanRename(root, stored.operation.id)
            : resumePlanTransfer(root, stored.operation.id),
        );
      const finished = finishPlanTransfers(root);
      console.log(
        finished.length ? `Transferred plans retired: ${finished.join(", ")}` : "Planning recovery complete.",
      );
    });
  plans
    .command("rename")
    .description("Rename a plan and update its relationships and queue references")
    .argument("<name>")
    .argument("<new-name>")
    .requiredOption("--expected <digest>", "Inspected plan version")
    .action((value: string, target: string, options: { expected: string }, command: Command) => {
      show(renamePlan(root, identity(value, command), identity(target, command), options.expected), command);
    });
  for (const detach of [false, true])
    plans
      .command(detach ? "detach" : "attach")
      .description(detach ? "Remove a supporting file from the draft" : "Save a supporting file in the durable draft")
      .argument("<name>")
      .argument("<file>")
      .option("--name <path>", "Supporting-file path within the plan")
      .requiredOption("--expected <digest>", "Inspected plan version")
      .action((value: string, file: string, options: { expected: string; name?: string }, command: Command) => {
        const selected = identity(value, command),
          view = readPlan(root, selected),
          entries = [...view.entries].filter(([path]) => path.startsWith(planningPaths.files)),
          objects = readGitObjects(
            root,
            entries.map(([, entry]) => entry.oid),
            8 * 1024 * 1024,
            { retainedBytes: 16 * 1024 * 1024 },
          ),
          files = new Map(
            entries.map(([path, entry]) => {
              const contents = objects.get(entry.oid);
              if (!contents) throw new InvalidInput("Supporting file unavailable");
              return [path.slice(planningPaths.files.length), { contents, executable: entry.mode === "100755" }];
            }),
          ),
          name = options.name ?? (detach ? file : basename(file));
        if (detach) {
          if (!files.delete(name)) throw new InvalidInput("Supporting file not found");
        } else
          files.set(name, {
            contents: readBoundedFile(file, 8 * 1024 * 1024, "supporting file"),
            executable: (lstatSync(file).mode & 0o111) !== 0,
          });
        show(savePlanDraft(root, selected, view.contents, { expected: options.expected, files }), command);
      });
  plans
    .command("cancel")
    .description("Keep the plan with the reason work was canceled")
    .argument("<name>")
    .requiredOption("--reason <text>", "Why the work is being canceled")
    .requiredOption("--expected <digest>", "Inspected plan version")
    .action((value: string, options: { reason: string; expected: string }, command: Command) => {
      show(cancelPlan(root, identity(value, command), options.expected, options.reason), command);
    });
  plans
    .command("delete")
    .description("Preview or delete a future plan while protecting relationships and queued work")
    .argument("<name>")
    .option("--apply", "Confirm the inspected deletion")
    .option("--expected <digest>", "Digest from the deletion preview")
    .action((value: string, options: { apply?: boolean; expected?: string }, command: Command) => {
      const selected = identity(value, command);
      if (options.apply) {
        if (!options.expected) throw new InvalidInput("Inspect the deletion, then supply its --expected digest");
        const recovery = deletePlan(root, selected, options.expected);
        console.log(
          command.optsWithGlobals<PlanOptions>().json
            ? JSON.stringify({ reference: selected.reference, recovery })
            : `Deleted plan. Recovery: ${recovery}`,
        );
      } else {
        const plan = planDeletion(root, selected);
        console.log(
          command.optsWithGlobals<PlanOptions>().json
            ? JSON.stringify(plan, null, 2)
            : `${plan.title}\n${plan.files.join("\n")}\n\n${plan.problems.join("\n")}\nDeletion digest: ${plan.digest}`,
        );
      }
    });
  plans
    .command("approve")
    .description("Record human approval and checkpoint the selected plan")
    .argument("<name>")
    .requiredOption("--expected <digest>", "Version presented for review")
    .action(async (value: string, options: { expected: string }, command: Command) => {
      if (!terminalAvailable()) throw new InvalidInput("Approve plans in an interactive terminal or the browser");
      const selected = identity(value, command),
        view = readPlan(root, selected);
      if (view.digest !== options.expected)
        throw new InvalidInput("Plan changed; inspect its current version before approval");
      console.log(safeOutput(view.contents));
      files(view);
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!/^(?:y|yes)$/i.test((await prompt.question("Approve this plan? [y/N] ")).trim())) return;
        show(approvePlanDraft(root, selected, options.expected, true), command);
      } finally {
        prompt.close();
      }
    });
  for (const command of plans.commands)
    command
      .option("--project <id>", "Resolve plan names in this project scope")
      .option("--json", "Print structured planning information");
}
