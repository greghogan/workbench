import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { safeOutput } from "../core/diagnostics/terminal-output.js";
import { readConfig } from "../core/projects/project-configuration.js";
import { InvalidInput, StateConflict } from "../core/runtime/input-errors.js";
import { parsePlanReference } from "../core/tasks/planning/plan-model.js";
import { approvePlanDraft } from "../core/tasks/planning/planning-operations.js";
import { readWorkGraph } from "../core/tasks/planning/work-plans.js";
import { prepareTaskReview } from "../core/tasks/task-formatting.js";
import { readTaskQueue, TaskReadiness } from "../core/tasks/task-queue.js";
import { changeTaskStatus, taskTransitionProblem } from "../core/tasks/task-service.js";
import { requestAutomaticFinalization } from "../core/git/finalization-requests.js";
import { terminalAvailable } from "./terminal/terminal-choice.js";

export function registerTaskDecisionCommands(
  tasks: Command,
  root: string,
  resolve: (value: string, command: Command) => string,
): void {
  for (const [name, status, description] of [
    ["approve", "Approved", "Record human approval of selected plans"],
    ["accept", "Accepted", "Record human acceptance of selected task outcomes"],
  ] as const)
    tasks
      .command(name)
      .description(description)
      .argument("<references...>")
      .option(
        "--expected <sha256>",
        "Inspected version; repeat in reference order for a batch",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .action(async (values: string[], options: { expected: string[] }, command: Command) => {
        if (options.expected.length && options.expected.length !== values.length)
          throw new InvalidInput("Supply one --expected value per reference, in the same order");
        const ids = values.map((value) => resolve(value, command));
        if (new Set(ids).size !== ids.length) throw new InvalidInput("Select each plan or task once");
        const confirm =
          ids.length > 1 || ids.some((id) => id.includes(":plan/")) || readConfig(root).review?.task_approvals === true;
        if (confirm && !terminalAvailable())
          throw new InvalidInput("Human task decisions require an interactive terminal or the task page");

        const inspect = (versions: (string | undefined)[]) => {
          const graph = readWorkGraph(root),
            readiness = new TaskReadiness(graph, readTaskQueue(root));
          return ids.map((id, index) => {
            const task = graph.require(id),
              digest = task.reviewDigest ?? task.digest;
            if (versions[index] !== undefined && versions[index] !== digest)
              throw new StateConflict(`${id}: changed since inspection; review the current version`);
            if (task.archived) throw new StateConflict(`${id}: restore the archived task before reviewing`);
            const problem = task.planning ? task.planning.problem : taskTransitionProblem(task, readiness, status);
            if (task.planning && status === "Accepted")
              throw new InvalidInput(`${id}: accept the implemented task, using its numbered reference`);
            if (problem) throw new StateConflict(`${id}: ${problem}`);
            return { id, digest, task };
          });
        };
        let selection = inspect(options.expected);
        if (confirm) {
          const prepared = [];
          for (const item of selection) prepared.push(await prepareTaskReview(root, item.id, item.digest));
          selection = inspect(prepared);
          for (const { id, task } of selection) {
            console.log(safeOutput(selection.length === 1 ? task.contents : `${id}\n${task.contents}`));
          }
          const question =
            selection.length === 1
              ? status === "Approved"
                ? "Approve this plan"
                : "Accept this delivered result"
              : `${status === "Approved" ? "Approve" : "Accept"} all ${String(selection.length)} items`;
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            if (!/^(?:y|yes)$/i.test((await prompt.question(`${question}? [y/N] `)).trim())) return;
          } finally {
            prompt.close();
          }
          selection = inspect(prepared);
        }

        const applied: { reference: string; status: typeof status }[] = [];
        for (const { id, digest, task } of selection) {
          try {
            if (task.planning) approvePlanDraft(root, parsePlanReference(id), digest, confirm);
            else changeTaskStatus(root, id, status, digest, confirm);
          } catch (error) {
            if (applied.length) {
              if (status === "Accepted")
                requestAutomaticFinalization(root, { tasks: applied.map((item) => item.reference) });
              throw new StateConflict(
                `Decisions recorded for ${applied.map((item) => item.reference).join(", ")}. Stopped at ${id}.`,
                { cause: error },
              );
            }
            throw error;
          }
          applied.push({ reference: id, status });
        }
        if (command.optsWithGlobals<{ json?: boolean }>().json)
          console.log(JSON.stringify(applied.length === 1 ? applied[0] : applied));
        else for (const item of applied) console.log(`${item.reference}: ${item.status}`);
        if (status === "Accepted") requestAutomaticFinalization(root, { tasks: applied.map((item) => item.reference) });
      });
}
