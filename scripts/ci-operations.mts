import type { CITarget } from "../src/ci-targets.js";
import type { CIPhase } from "./ci-contract.mjs";
import { createHash } from "node:crypto";

export enum CIOperation {
  Checks = "checks",
  Integration = "integration",
  Release = "release",
}

export function readCIOperation(value: unknown): CIOperation {
  for (const operation of Object.values(CIOperation)) if (operation === value) return operation;
  throw new Error("Unknown CI operation");
}

export interface CIJob {
  id: string;
  artifact: string;
  label: string;
  operation: CIOperation;
  targets: CITarget[];
}

/** Schedule complete configured profiles and operations without creating project scopes. */
export function operationPhases(target: CITarget, operation: CIOperation): CIPhase[] {
  return target.phases.filter((phase) =>
    operation === CIOperation.Checks
      ? phase !== "integration" && phase !== "release"
      : operation === CIOperation.Integration
        ? phase === "integration"
        : phase === "release",
  );
}

export function nativeCIJobs(targets: CITarget[], os: string, architecture: string): CIJob[] {
  const selected = targets.filter(
    (target) => target.os === os && target.architecture === architecture && target.kind !== "environment",
  );
  if (!selected.length || new Set(selected.map((target) => target.id)).size !== selected.length)
    throw new Error("Native CI requires a nonempty catalog of unique targets");
  return configuredCIJobs(selected);
}

export function configuredCIJobs(selected: CITarget[]): CIJob[] {
  if (!selected.length || new Set(selected.map((target) => target.id)).size !== selected.length)
    throw new Error("CI operations require unique configured targets");
  const groups = new Map<string, { operation: CIOperation; targets: CITarget[] }>();
  for (const target of selected) {
    for (const operation of Object.values(CIOperation)) {
      if (!operationPhases(target, operation).length) continue;
      const selection =
        operation !== CIOperation.Checks
          ? operation
          : target.kind === "environment"
            ? JSON.stringify([operation, target.environment])
            : target.kind === "native"
              ? JSON.stringify([operation, target.toolchain ?? null])
              : JSON.stringify([operation, target.runtime, target.version, target.roles]);
      const group = groups.get(selection) ?? { operation, targets: [] };
      group.targets.push(target);
      groups.set(selection, group);
    }
  }
  return [...groups].map(([id, group]) => ({
    id,
    label:
      group.operation === CIOperation.Integration
        ? "Consumer integration"
        : group.operation === CIOperation.Release
          ? "Release verification"
          : group.targets[0]?.kind === "compatibility"
            ? `Checks / ${group.targets[0].runtime} ${group.targets[0].version}`
            : `Checks / ${group.targets[0]?.kind === "native" ? (group.targets[0].toolchain ?? "development pins") : "configured profile"}`,
    artifact: `${group.operation}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`,
    ...group,
  }));
}

/** Every configured phase has exactly one owner; missing and duplicate work both fail. */
export function assertOperationCoverage(targets: CITarget[], jobs: CIJob[]): void {
  const expected = targets.flatMap((target) => target.phases.map((phase) => JSON.stringify([target.id, phase])));
  const actual = jobs.flatMap((job) =>
    job.targets.flatMap((target) =>
      operationPhases(target, job.operation).map((phase) => JSON.stringify([target.id, phase])),
    ),
  );
  if (
    new Set(expected).size !== expected.length ||
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((unit) => !expected.includes(unit))
  )
    throw new Error("CI operations do not cover every configured target phase exactly once");
}
