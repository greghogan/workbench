import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { record, records, string } from "../../scripts/values.mjs";
export interface WorkflowStep {
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface JobSettings {
  permissions?: Record<string, string>;
  strategy?: { matrix: { include: Record<string, string>[] } };
}
export interface ExecutionJob extends JobSettings {
  kind: "execution";
  steps: WorkflowStep[];
  uses?: never;
}
export interface ReusableJob extends JobSettings {
  kind: "reusable";
  uses: string;
  steps?: never;
}
export type WorkflowJob = ExecutionJob | ReusableJob;
export interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}
const scalars = (value: unknown) =>
  Object.fromEntries(
    Object.entries(record(value, "Expected workflow mapping")).map(([key, value]) => {
      if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`Invalid workflow scalar: ${key}`);
      return [key, String(value)];
    }),
  );
export function parseWorkflow(value: unknown): Workflow {
  const data = record(value, "Invalid workflow");
  return {
    on: record(data.on, "Missing workflow events"),
    permissions: scalars(data.permissions ?? {}),
    jobs: Object.fromEntries(
      Object.entries(record(data.jobs, "Missing workflow jobs")).map(([id, raw]): [string, WorkflowJob] => {
        const job = record(raw, `Invalid workflow job ${id}`);
        const settings: JobSettings = job.permissions === undefined ? {} : { permissions: scalars(job.permissions) };
        if (job.strategy !== undefined) {
          const strategy = record(job.strategy, "Invalid job strategy");
          if (typeof strategy.matrix === "object" && strategy.matrix !== null) {
            const matrix = record(strategy.matrix, "Invalid job matrix");
            if (matrix.include !== undefined)
              settings.strategy = {
                matrix: { include: records(matrix.include, "Invalid job matrix entries").map(scalars) },
              };
          }
        }
        if (job.uses !== undefined) {
          if (job.steps !== undefined) throw new Error(`Reusable workflow job ${id} cannot also declare steps`);
          return [
            id,
            {
              ...settings,
              kind: "reusable",
              uses: string(job.uses, "Missing reusable workflow"),
            } satisfies ReusableJob,
          ];
        }
        return [
          id,
          {
            ...settings,
            kind: "execution",
            steps: records(job.steps, `Missing steps for job ${id}`).map((raw) => {
              const step: WorkflowStep = {};
              for (const key of ["id", "run", "uses", "if"] as const)
                if (raw[key] !== undefined) step[key] = string(raw[key], `Invalid step ${key}`);
              for (const key of ["with", "env"] as const) if (raw[key] !== undefined) step[key] = scalars(raw[key]);
              return step;
            }),
          } satisfies ExecutionJob,
        ];
      }),
    ),
  };
}
export function readWorkflow(path: string | URL): Workflow {
  return parseWorkflow(parse(readFileSync(path, "utf8")));
}
export function executionJob(workflow: Workflow, id: string): ExecutionJob {
  const job = workflow.jobs[id];
  if (job?.kind !== "execution") throw new Error(`Expected executable workflow job ${id}`);
  return job;
}
export function reusableJob(workflow: Workflow, id: string): ReusableJob {
  const job = workflow.jobs[id];
  if (job?.kind !== "reusable") throw new Error(`Expected reusable workflow call ${id}`);
  return job;
}
