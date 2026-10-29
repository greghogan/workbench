import { terminalAvailable } from "../terminal-choice.js";
import { createInterface } from "node:readline/promises";
import { Option, type Command } from "commander";
import { registerCommand } from "./commands.js";
import { readConfig, selectProject, currentProject } from "../project-configuration.js";
import { terminalTable } from "../terminal-table.js";
import { taskStatuses, terminalTask, type TaskStatus } from "../record-document.js";
import { readTaskGraph, taskReference, type TaskNode } from "../task-model.js";
import { changeTaskStatus } from "../task-service.js";
import { readTaskQueue, inspectTaskQueue, TaskReadiness, changeTaskQueue, type QueueChange } from "../task-queue.js";

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
      command.opts<TaskOptions>().project ?? (value.includes(":") ? undefined : currentProject(root)),
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
    .description("Read a task and its exact version")
    .argument("<reference>")
    .option("--json", "Print the record and metadata as JSON")
    .action((value: string, options: { json?: boolean }) => {
      const task = readTaskGraph(root).require(reference(value, tasks));
      console.log(
        options.json || tasks.opts<TaskOptions>().json
          ? JSON.stringify(
              {
                reference: task.reference,
                title: task.title,
                ...task.metadata,
                digest: task.digest,
                contents: task.contents,
              },
              null,
              2,
            )
          : task.contents,
      );
    });
  for (const [name, status, description] of [
    ["approve", "Approved", "Record human approval of the current plan"],
    ["accept", "Accepted", "Record human acceptance of the delivered outcome"],
    ["replan", "Planned", "Return a task to planning and revoke local execution evidence"],
    ["cancel", "Canceled", "Cancel a task while retaining its record"],
  ] as const)
    tasks
      .command(name)
      .description(description)
      .argument("<reference>")
      .option("--expected <sha256>", "Reject a task changed since inspection")
      .action(async (value: string, options: { expected?: string }) => {
        const id = reference(value, tasks);
        const guarded = readConfig(root).review?.task_approvals === true && ["Approved", "Accepted"].includes(status);
        let expected = options.expected;
        if (guarded) {
          if (!terminalAvailable())
            throw new Error("Human task decisions require an interactive terminal or the task page");
          const task = readTaskGraph(root).require(id);
          expected ??= task.digest;
          console.log(task.contents);
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            if (
              !/^(?:y|yes)$/i.test(
                (
                  await prompt.question(
                    `${status === "Approved" ? "Approve this plan" : "Accept this delivered result"}? [y/N] `,
                  )
                ).trim(),
              )
            )
              return;
          } finally {
            prompt.close();
          }
        }
        changeTaskStatus(root, id, status, expected, guarded);
        if (tasks.opts<TaskOptions>().json) console.log(JSON.stringify({ reference: id, status }));
        else console.log(`${id}: ${status}`);
      });

  const queue = registerCommand(program, "queue")
    .description("Manage this checkout's local task execution queue")
    .option("--json", "Print the queue and dependency readiness")
    .option("--project <id>", "Resolve short references in this project scope")
    .option("--ready", "Show approved tasks with satisfied prerequisites");
  const inspect = () => {
    const options = queue.opts<TaskOptions>(),
      state = inspectTaskQueue(root);
    const entries = options.ready
      ? state.entries.filter((entry) => state.ready.includes(entry.reference))
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
  const mutate = (change: QueueChange) => {
    changeTaskQueue(root, change);
    inspect();
  };
  queue.action(inspect);
  queue
    .command("add")
    .argument("<references...>")
    .description("Select approved tasks for local execution")
    .action((values: string[]) => {
      mutate({ action: "add", references: values.map((value) => reference(value, queue)) });
    });
  queue
    .command("move")
    .description("Reorder a selected task without changing its progress")
    .argument("<reference>")
    .option("--before <reference>", "Place before another queued task")
    .option("--after <reference>", "Place after another queued task")
    .action((value: string, options: { before?: string; after?: string }) => {
      mutate({
        action: "move",
        reference: reference(value, queue),
        ...(options.before ? { before: reference(options.before, queue) } : {}),
        ...(options.after ? { after: reference(options.after, queue) } : {}),
      });
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
      .action((value: string) => {
        mutate({ action: name, reference: reference(value, queue) });
      });
  queue
    .command("implemented")
    .description("Record verified implementation pending human acceptance")
    .argument("<reference>")
    .requiredOption("--evidence <text>", "Verification performed and its outcome")
    .action((value: string, options: { evidence: string }) => {
      mutate({ action: "implemented", reference: reference(value, queue), detail: options.evidence });
    });
  queue
    .command("block")
    .description("Suspend a task with an explicit blocking reason")
    .argument("<reference>")
    .argument("<reason>")
    .action((value: string, detail: string) => {
      mutate({ action: "block", reference: reference(value, queue), detail });
    });
}
