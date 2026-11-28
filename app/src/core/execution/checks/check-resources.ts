import { checkExecutionResources } from "../environments/execution-resources.js";
import { checkGroupDependencies } from "./check-order.js";
import type { CheckPlan } from "./check-plan.js";

/** Admission, inspection, and evidence share dependencies and optional tool limits. */
export function checkExecution(root: string, plan: CheckPlan) {
  const dependencies = checkGroupDependencies(root, plan.sessions, plan.ordering, plan.automatic);
  const resources = checkExecutionResources(root, Math.max(1, plan.resourceSessions ?? plan.sessions.length));
  return { dependencies, ...resources, maxJobs: plan.cleanup ? 1 : resources.maxJobs };
}
