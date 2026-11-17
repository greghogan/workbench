import { taskDisposition, applyTaskDisposition } from "../core/tasks/task-disposition.js";
import { changeWorkQueue } from "../core/tasks/planning/plan-transfer.js";
import { createPatch } from "diff";
import { InvalidInput } from "../core/runtime/input-errors.js";
import { workReference } from "../core/tasks/planning/work-plans.js";
import { registerTaskPlanCommands } from "./task-plans.js";
import { registerTaskDecisionCommands } from "./task-decisions.js";
import { Option, type Command } from "commander";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { currentProject, selectProject } from "../core/projects/project-configuration.js";
import { taskStatuses, terminalTask, type TaskStatus } from "../core/records/record-document.js";
import type { TaskRecord } from "../core/tasks/task-model.js";
import { readTaskGraph, taskReference, type TaskNode } from "../core/tasks/task-model.js";
import { inspectTaskQueue, readTaskQueue, TaskReadiness, type QueueChange } from "../core/tasks/task-queue.js";
import { authorizeProjectReview, changeTaskStatus } from "../core/tasks/task-service.js";
import { registerCommand } from "./commands.js";

interface TaskOptions {
  json?: boolean;
  all?: boolean;
  ready?: boolean;
  status?: TaskStatus;
  project?: string;
}
export function registerTaskCommands(program: Command, root: string): void {
  const tasks = registerCommand(program, "task")
    .description("Inspect task hierarchy and record plan approval or outcome acceptance")
    .option("--json", "Print structured task and readiness information")
    .option("--all", "Include accepted and canceled tasks")
    .option("--ready", "List approved tasks whose prerequisites are implemented")
    .option("--project <id>", "Resolve short references in this project scope")
    .addOption(new Option("--status <state>", "Select a shared task state").choices(taskStatuses));
  const reference = (value: string, command: Command) =>
    taskReference(
      root,
      value,
      command.optsWithGlobals<TaskOptions>().project ?? (value.includes(":") ? undefined : currentProject(root)),
    );
  tasks.action((options: TaskOptions) => {
    const graph = readTaskGraph(root),
      all = graph.tasks,
      queue = readTaskQueue(root);
    const readiness = new TaskReadiness(graph, queue);
    const scope = options.project ? selectProject(root, options.project).id : undefined;
    const selected = all.filter(
      (task) =>
        (!scope || task.reference.startsWith(scope + ":")) &&
        (options.status
          ? task.metadata.status === options.status
          : (options.all ?? false) || !terminalTask.has(task.metadata.status)) &&
        (!options.ready || readiness.blockers(task).length === 0),
    );
    const rows: {
      reference: string;
      title: string;
      depth: number;
      status: TaskStatus;
      parent?: string;
      dependencies: string[];
      execution?: string;
      implementation?: TaskRecord["implementation"];
      ready: boolean;
      blockers: string[];
    }[] = [];
    const walk = (nodes: TaskNode[], depth = 0) => {
      for (const { task, children } of nodes) {
        const blockers = readiness.blockers(task).map((blocker) => blocker.message),
          entry = readiness.entries.get(task.reference);
        rows.push({
          reference: task.reference,
          title: task.title,
          depth,
          status: task.metadata.status,
          ...(task.parent ? { parent: task.parent } : {}),
          dependencies: task.dependencies,
          ...(entry ? { execution: entry.state } : {}),
          ...(task.implementation ? { implementation: task.implementation } : {}),
          ready: blockers.length === 0,
          blockers,
        });
        walk(children, depth + 1);
      }
    };
    walk(graph.forest(selected));
    if (options.json) console.log(JSON.stringify(rows, null, 2));
    else
      console.log(
        terminalTable(
          ["TASK", "STATE", "LOCAL", "TITLE", "READINESS"],
          rows.map((task) => [
            task.reference,
            task.status,
            task.execution ?? "",
            "  ".repeat(task.depth) + task.title,
            task.ready ? "Ready" : task.blockers.join("; "),
          ]),
        ),
      );
  });
  tasks
    .command("show")
    .description("Read a task or its diff since plan approval")
    .argument("<reference>")
    .option("--json", "Print the record and metadata as JSON")
    .option("--diff", "Show changes since the retained plan approval")
    .action((value: string, options: { diff?: boolean }, command: Command) => {
      const task = readTaskGraph(root).require(reference(value, command));
      if (options.diff) {
        if (!task.approval) throw new InvalidInput("This task has no retained approval snapshot");
        console.log(createPatch(task.reference, task.approval.contents, task.contents));
        for (const file of task.approval.files) console.log(`${file.change}: ${file.name}`);
        return;
      }
      console.log(
        command.optsWithGlobals<TaskOptions>().json
          ? JSON.stringify(
              {
                reference: task.reference,
                title: task.title,
                ...task.metadata,
                digest: task.reviewDigest ?? task.digest,
                approval: task.approval,
                contents: task.contents,
                ...(task.implementation ? { implementation: task.implementation } : {}),
              },
              null,
              2,
            )
          : task.contents +
              (task.implementation
                ? `\nImplementation evidence at ${task.implementation.baseline}\nSource checkout: ${task.implementation.checkout}\nVerified: ${task.implementation.verified}\n${task.implementation.evidence}\n`
                : ""),
      );
    });
  registerTaskDecisionCommands(tasks, root, (value, command) =>
    workReference(
      root,
      value,
      command.optsWithGlobals<TaskOptions>().project ?? (value.includes(":") ? undefined : currentProject(root)),
    ),
  );
  for (const [name, status, description] of [
    ["replan", "Planned", "Return a task to planning and revoke local execution evidence"],
    ["cancel", "Canceled", "Cancel a task while retaining its record"],
  ] as const)
    tasks
      .command(name)
      .description(description)
      .argument("<reference>")
      .option("--expected <sha256>", "Reject a task changed since inspection")
      .option("--reason <text>", "Reason for canceling work")
      .action((value: string, options: { expected?: string; reason?: string }, command: Command) => {
        const id = reference(value, command);
        changeTaskStatus(root, id, status, options.expected, false, options.reason);
        if (command.optsWithGlobals<TaskOptions>().json) console.log(JSON.stringify({ reference: id, status }));
        else console.log(`${id}: ${status}`);
      });
  tasks
    .command("authorize-review")
    .description("Record the developer's explicit request to queue a scoped project review")
    .argument("<reference>")
    .requiredOption("--expected <digest>", "Task version containing the requested scope")
    .action((value: string, options: { expected: string }, command: Command) => {
      const id = reference(value, command);
      authorizeProjectReview(root, id, options.expected);
      if (command.optsWithGlobals<TaskOptions>().json)
        console.log(JSON.stringify({ reference: id, source: "developer-requested-review" }));
      else console.log(`${id}: queued at the developer's request`);
    });
  for (const kind of ["delete", "revert"] as const)
    tasks
      .command(kind)
      .description(
        kind === "delete"
          ? "Preview removal of an unpublished task's unmixed commit suffix"
          : "Preview an inverse change retaining the original task history",
      )
      .argument("<reference>")
      .option("--reason <text>", "Reason for reverting the task")
      .option("--apply", "Confirm the inspected operation")
      .option("--expected <digest>", "Digest from the operation preview")
      .action((value: string, options: { apply?: boolean; expected?: string; reason?: string }, command: Command) => {
        const selected = reference(value, command);
        if (options.apply) {
          if (!options.expected) throw new InvalidInput("Inspect the operation, then supply --expected");
          const recovery = applyTaskDisposition(root, {
            reference: selected,
            kind,
            reason: options.reason ?? "",
            expected: options.expected,
          });
          console.log(
            command.optsWithGlobals<TaskOptions>().json
              ? JSON.stringify({ reference: selected, kind, recovery })
              : `${kind === "delete" ? "Removed unpublished task commits" : "Staged inverse changes; verify and accept the revised outcome"}. Recovery: ${recovery}`,
          );
        } else {
          const plan = taskDisposition(root, selected, kind, options.reason);
          console.log(
            command.optsWithGlobals<TaskOptions>().json
              ? JSON.stringify(plan, null, 2)
              : `${plan.reference}: ${kind}\n${plan.commits.map((revision) => revision.slice(0, 12)).join("\n")}\n\n${plan.updates.map((file) => file.path).join("\n")}\n\n${plan.problems.join("\n\n")}\n\nOperation digest: ${plan.digest}`,
          );
        }
      });
  tasks
    .command("recover")
    .description("Resume a prepared task deletion or inverse change")
    .action(() => {
      console.log(`Task operation recovered. Recovery: ${applyTaskDisposition(root, { recover: true })}`);
    });
  registerTaskPlanCommands(tasks, root);
  for (const command of tasks.commands) {
    command.option("--project <id>", "Resolve short references in this project scope");
    if (!command.options.some((option) => option.attributeName() === "json"))
      command.option("--json", "Print the resulting task state as JSON");
  }

  const queue = registerCommand(program, "queue")
    .description("Manage this checkout's local task execution queue")
    .option("--json", "Print the queue and dependency readiness")
    .option("--project <id>", "Resolve short references in this project scope")
    .option("--ready", "Show approved tasks with satisfied prerequisites");
  const inspect = (options: TaskOptions) => {
    const state = inspectTaskQueue(root);
    const byReference = new Map(state.entries.map((entry) => [entry.reference, entry]));
    const entries = options.ready
      ? state.ready.flatMap((reference) => byReference.get(reference) ?? [])
      : state.entries;
    if (options.json) console.log(JSON.stringify({ ...state, entries }, null, 2));
    else {
      console.log("Local queue");
      console.log(
        terminalTable(
          ["ORDER", "TASK", "LOCAL", "TITLE", "READINESS"],
          entries.map((entry) => [
            String(entry.position),
            entry.reference,
            entry.state,
            entry.title,
            entry.ready ? "Ready" : entry.blockers.join("; "),
          ]),
        ),
      );
    }
  };
  const queueReference = (value: string, command: Command) =>
    workReference(
      root,
      value,
      command.optsWithGlobals<TaskOptions>().project ?? (value.includes(":") ? undefined : currentProject(root)),
    );
  const mutate = async (change: QueueChange, command: Command) => {
    await changeWorkQueue(root, change);
    inspect(command.optsWithGlobals<TaskOptions>());
  };
  queue.action(inspect);
  queue
    .command("add")
    .argument("<references...>")
    .description("Restore approved work to the local execution queue")
    .action((values: string[], _options: unknown, command: Command) => {
      return mutate({ action: "add", references: values.map((value) => queueReference(value, command)) }, command);
    });
  queue
    .command("move")
    .description("Reorder a selected task without changing its progress")
    .argument("<reference>")
    .option("--before <reference>", "Place before another queued task")
    .option("--after <reference>", "Place after another queued task")
    .action((value: string, options: { before?: string; after?: string }, command: Command) => {
      return mutate(
        {
          action: "move",
          reference: queueReference(value, command),
          ...(options.before ? { before: queueReference(options.before, command) } : {}),
          ...(options.after ? { after: queueReference(options.after, command) } : {}),
        },
        command,
      );
    });
  for (const [name, description] of [
    ["remove", "Remove an inactive task from this queue"],
    ["start", "Claim a ready task for implementation"],
    ["release", "Return local progress to queued and revoke its evidence"],
  ] as const)
    queue
      .command(name)
      .description(description)
      .argument("<reference>")
      .action((value: string, _options: unknown, command: Command) => {
        return mutate({ action: name, reference: queueReference(value, command) }, command);
      });
  queue
    .command("implemented")
    .description("Record verified implementation pending human acceptance")
    .argument("<reference>")
    .requiredOption("--evidence <text>", "Verification performed and its outcome")
    .action((value: string, options: { evidence: string }, command: Command) => {
      return mutate(
        { action: "implemented", reference: queueReference(value, command), detail: options.evidence },
        command,
      );
    });
  queue
    .command("block")
    .description("Suspend a task with an explicit blocking reason")
    .argument("<reference>")
    .argument("<reason>")
    .action((value: string, detail: string, _options: unknown, command: Command) => {
      return mutate({ action: "block", reference: queueReference(value, command), detail }, command);
    });
  for (const command of queue.commands)
    command
      .option("--project <id>", "Resolve short references in this project scope")
      .option("--json", "Print the resulting queue and readiness as JSON");
}
