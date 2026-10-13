export interface HostedPlan {
  native: { include: Record<string, unknown>[] };
  compatibility: { include: Record<string, unknown>[] };
  environments: { include: Record<string, unknown>[] };
  devcontainer: { paths: string[] };
}
export function matrixJobGroups(matrix: unknown): Record<"native" | "environments" | "devcontainer", boolean>;
export function readHostedPlan(value: unknown): HostedPlan;
