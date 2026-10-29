import type { ProcessLock } from "../../src/process-lock.js";
/** Publications may expose a digest without a download URL; a name alone is not an identity. */
export type ReleaseAsset = { name: string } & ({ url: string; sha256?: string } | { url?: string; sha256: string });
export interface Release {
  version: string;
  reference: string;
  assets?: ReleaseAsset[];
  revision?: string;
  integrity?: string;
  evidence?: { path: string; sha256: string }[];
}

export enum MaintenanceKind {
  Dependencies = "dependencies",
  Toolchains = "toolchains",
  Environments = "environments",
  Automation = "automation",
}
export enum MaintenanceState {
  Current = "current",
  Available = "available",
  Constrained = "constrained",
  Unavailable = "unavailable",
}
export enum MaintenanceProvider {
  Npm = "npm",
  Python = "pypi",
  Ruby = "rubygems",
  Composer = "composer",
  Maven = "maven",
  Cargo = "cargo",
  Go = "go-module",
  Tool = "tool",
  Nix = "nix",
  Guix = "guix",
  Action = "github-action",
  Image = "docker-image",
}
export type MaintenanceLocator =
  | { kind: "field"; path: string[] }
  | { kind: "group"; name: string }
  | { kind: "property"; name: string }
  | { kind: "marker"; name: string }
  | { kind: "nix"; repository: string; reference: { kind: "branch" | "revision"; value: string } }
  | { kind: "action"; revision: string }
  | { kind: "image"; reference: string };
interface TargetBase {
  id: string;
  kind: MaintenanceKind;
  path: string;
  name: string;
  current: string;
  /** Package coordinates or a property name; never a command or arbitrary output path. */
  platform?: string;
}
export type MaintenanceTarget = TargetBase &
  (
    | {
        provider:
          | MaintenanceProvider.Npm
          | MaintenanceProvider.Python
          | MaintenanceProvider.Cargo
          | MaintenanceProvider.Composer;
        locator?: Extract<MaintenanceLocator, { kind: "group" }>;
      }
    | { provider: MaintenanceProvider.Maven; locator?: Extract<MaintenanceLocator, { kind: "property" }> }
    | { provider: MaintenanceProvider.Nix; locator: Extract<MaintenanceLocator, { kind: "nix" }> }
    | { provider: MaintenanceProvider.Action; locator: Extract<MaintenanceLocator, { kind: "action" }> }
    | { provider: MaintenanceProvider.Image; locator?: Extract<MaintenanceLocator, { kind: "field" }> }
    | { provider: MaintenanceProvider.Guix | MaintenanceProvider.Go | MaintenanceProvider.Ruby; locator?: never }
    | {
        provider: MaintenanceProvider.Tool;
        locator?: Extract<MaintenanceLocator, { kind: "field" | "marker" | "image" }>;
      }
  );
export type MaintenanceEntry = MaintenanceTarget &
  (
    | { state: MaintenanceState.Available; selected: Release; latest?: string; reason?: string }
    | { state: MaintenanceState.Current; selected?: Release; latest?: string; reason?: string }
    | {
        state: MaintenanceState.Constrained | MaintenanceState.Unavailable;
        selected?: never;
        latest?: string;
        reason: string;
      }
  );
export interface MaintenancePlan {
  schema_version: 2;
  created: string;
  inputs: Record<string, string>;
  entries: MaintenanceEntry[];
}

export function requestedVersion(current: string): string {
  if (/^v\d+\.\d+\.\d+-\d{14}-[a-f0-9]+$/.test(current)) return current.slice(1);
  return (
    /(?:^|[~^<>=!@\s])v?(\d+(?:\.\d+)*(?:\+\d+)?(?:-jre|-android)?)/.exec(current)?.[1] ?? current.replace(/^v/, "")
  );
}

export function declaredVersion(target: MaintenanceTarget): string {
  return target.provider === MaintenanceProvider.Go
    ? target.current.replace(/^v/, "")
    : requestedVersion(target.current);
}

export interface MaintenanceCommand {
  command: string;
  arguments: string[];
  cwd: string;
  environment?: Record<string, string>;
  capture?: boolean;
  checksums?: { path: string; environment: string };
}
export type MaintenanceRunner = (command: MaintenanceCommand, owner?: ProcessLock) => Promise<string>;
