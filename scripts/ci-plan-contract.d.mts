import type { CISelection } from "../src/ci-selection.js";

export interface HostedPlan {
  native: { include: Record<string, unknown>[] };
  compatibility: { include: Record<string, unknown>[] };
  environments: { include: Record<string, unknown>[] };
  devcontainer: { paths: string[] };
  selection: CISelection;
}
export function matrixJobGroups(matrix: unknown): Record<"native" | "compatibility" | "environments" | "devcontainer", boolean>;
export function readHostedPlan(value: unknown): HostedPlan;
