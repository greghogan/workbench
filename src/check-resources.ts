import { executionResources } from "./execution-resources.js";
import { checkGroupDependencies, type CheckDependency, type OrderedCheckSession } from "./check-order.js";
import type { planChecks } from "./check-plan.js";

/** Fixed budgets bound admitted work without resizing a running session. */
export function allocateCheckCPUs(
  root: string,
  sessions: readonly OrderedCheckSession[],
  dependencies: readonly (readonly CheckDependency[])[],
  shared: ReturnType<typeof executionResources>,
  standaloneCPUs: number,
) {
  const { availableCpus, cpusPerJob, maxJobs } = shared;
  const cpus = sessions.map((session, index) => {
    if (session.directory !== root) return cpusPerJob;
    const overlapping = dependencies.filter((edges) =>
      edges.some((edge) => edge.session === index && edge.phase === "setup"),
    ).length;
    const reserve = overlapping
      ? Math.min(
          Math.floor(availableCpus / (4 * cpusPerJob)) * cpusPerJob,
          (maxJobs - 1) * cpusPerJob,
          overlapping * cpusPerJob,
        )
      : 0;
    return Math.min(standaloneCPUs, availableCpus - reserve);
  });
  return { availableCpus, maxJobs, cpus };
}

/** Execution, inspection, and successful-evidence identity share the same graph and budgets. */
export function checkExecution(root: string, plan: ReturnType<typeof planChecks>) {
  const dependencies = checkGroupDependencies(root, plan.sessions, plan.ordering, plan.automatic);
  const overlapping = dependencies.some((edges) => edges.some((edge) => edge.phase === "setup"));
  const rootGroups = plan.sessions.filter((session) => session.directory === root).length;
  const shared = executionResources(root, Math.max(1, plan.sessions.length - (overlapping ? 0 : rootGroups)));
  return {
    dependencies,
    ...allocateCheckCPUs(
      root,
      plan.sessions,
      dependencies,
      { ...shared, maxJobs: plan.cleanup ? 1 : shared.maxJobs },
      executionResources(root).cpusPerJob,
    ),
  };
}
