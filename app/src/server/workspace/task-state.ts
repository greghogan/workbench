import { parseTask, TaskGraph, type TaskRecord } from "../../core/tasks/task-model.js";
import { attachTaskDecisions } from "../../core/tasks/task-approvals.js";
import { attachTaskImplementations } from "../../core/tasks/task-implementations.js";

export interface TaskInput {
  reference: string;
  path: string;
  archived?: boolean;
  read: () => string;
}

/** Summaries and open workspaces use the same task errors, approval versions, and implementation evidence. */
export function taskRecordState(root: string, inputs: readonly TaskInput[]) {
  const records: TaskRecord[] = [],
    errors = new Map<string, string>();
  let problem = "";
  for (const input of inputs) {
    try {
      records.push({
        ...parseTask(root, input.reference, input.path, input.read()),
        ...(input.archived ? { archived: true } : {}),
      });
    } catch (error) {
      errors.set(input.reference, error instanceof Error ? error.message : String(error));
    }
  }
  try {
    attachTaskDecisions(root, records);
    new TaskGraph(records).validate();
    attachTaskImplementations(root, records);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  return { records, errors, problem };
}
