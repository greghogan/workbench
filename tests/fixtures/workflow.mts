export interface WorkflowStep {
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
export interface WorkflowJob {
  steps: WorkflowStep[];
  permissions?: Record<string, string>;
  strategy?: { matrix: { include: Record<string, string>[] } };
}
export interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob> & { native: WorkflowJob; publish: WorkflowJob };
}
