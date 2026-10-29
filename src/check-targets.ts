import { isRecord } from "../scripts/values.mjs";
import { InvalidInput } from "./input-errors.js";

const operatingSystems = ["linux", "macos", "windows"] as const;
const environments = ["native", "guix", "nix", "nix-docker", "devcontainer"] as const;
const architectures = ["x64", "arm64"] as const;
export interface TargetDefinition {
  operating_systems?: string[];
  environments?: string[];
  architectures?: string[];
  toolchain?: string | false;
}
export interface CheckTargets {
  operatingSystems: string[];
  environments: string[];
  architectures: string[];
  toolchain?: string | false;
}
export function selectedValues(value: unknown, allowed: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string" || !allowed.includes(item)))
    throw new InvalidInput(`${label}: expected a list drawn from ${allowed.join(", ")}`);
  if (new Set(value).size !== value.length) throw new InvalidInput(`${label}: duplicate selection`);
  return value as string[];
}
export function normalizeTargets(value: unknown, label: string): CheckTargets {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["operating_systems", "environments", "architectures", "toolchain"].includes(key))
  )
    throw new InvalidInput(`${label}: expected a CI target table with known fields`);
  const toolchain = value.toolchain;
  if (toolchain !== undefined && toolchain !== false && (typeof toolchain !== "string" || !toolchain.trim()))
    throw new InvalidInput(`${label}.toolchain must name a profile or be false`);
  const result: CheckTargets = {
    operatingSystems: selectedValues(
      value.operating_systems === undefined ? [...operatingSystems] : value.operating_systems,
      operatingSystems,
      `${label}.operating_systems`,
    ),
    environments: selectedValues(
      value.environments === undefined ? [...environments] : value.environments,
      environments,
      `${label}.environments`,
    ),
    architectures: selectedValues(
      value.architectures === undefined ? [...architectures] : value.architectures,
      architectures,
      `${label}.architectures`,
    ),
    ...(toolchain === undefined ? {} : { toolchain }),
  };
  if (!result.operatingSystems.length || !result.environments.length || !result.architectures.length)
    throw new InvalidInput(`${label}: CI targets must not be empty; use stages = [] for manual checks`);
  return result;
}
export function targetExclusion(
  targets: Partial<CheckTargets>,
  actual: {
    operatingSystem: string;
    environment: string;
    architecture: string;
    toolchain: string | false;
  },
): string | undefined {
  if (targets.operatingSystems && !targets.operatingSystems.includes(actual.operatingSystem))
    return "CI check excludes this operating system";
  if (targets.environments && !targets.environments.includes(actual.environment))
    return "CI check excludes this environment";
  if (targets.architectures && !targets.architectures.includes(actual.architecture))
    return "CI check excludes this architecture";
  if (targets.toolchain !== undefined && targets.toolchain !== actual.toolchain)
    return "CI check belongs to a different tool profile";
  return undefined;
}
