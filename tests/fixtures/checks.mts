import type { ConfiguredCheck, inspectChecks } from "../../src/checks.ts";
import type { planChecks } from "../../src/check-plan.ts";

export function configuredCheck(overrides: Partial<ConfiguredCheck> = {}): ConfiguredCheck {
  return {
    name: "Fixture check",
    role: "test",
    command: ["node", "--version"],
    project: { id: "fixture", path: "." },
    directory: ".",
    location: "fixture",
    warnSeconds: undefined,
    environment: "native",
    dockerImage: undefined,
    stages: ["commit", "ci"],
    online: false,
    requiresSetup: true,
    coverage: undefined,
    ...overrides,
  };
}
export function checkPlan(root: string, checks: ConfiguredCheck[]): ReturnType<typeof planChecks> {
  return {
    stage: undefined,
    cleanup: false,
    ordering: [],
    automatic: false,
    excluded: [],
    sessions: [{ directory: root, environment: "native", checks }],
  };
}
export function inspection(roles: string[]): ReturnType<typeof inspectChecks> {
  return {
    stage: null,
    structuralValidation: false,
    allowEmpty: false,
    execution: { availableCpus: 1, maxJobs: 1, sessions: [] },
    excluded: [],
    selected: roles.map((role) => ({
      name: role,
      role,
      path: ".",
      environment: "native",
      command: ["node", "--version"],
      source: undefined,
      stages: ["commit", "ci"],
      online: false,
      requiresSetup: true,
    })),
  };
}
