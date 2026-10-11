import { relative } from "node:path";
import { ciMatrix } from "./ci.js";
import { targetPhases, type TargetSelection, type CIPhase } from "../scripts/ci-contract.mjs";
import { readChecks } from "./checks.js";
import { planChecks } from "./check-plan.js";
import { terminalTable } from "./terminal-table.js";
import { compatibilityArguments, compatibilityChecks } from "./compatibility-checks.js";

export type CITarget = TargetSelection & {
  id: string;
  path: string;
  os: string;
  architecture: string;
  environment: string;
  phases: CIPhase[];
  checks: { name: string; role: string; command: string[]; source: string | undefined }[];
};

/** One configured target catalog serves hosted matrices and local selection. */
export function ciTargets(root: string): CITarget[] {
  const matrix = ciMatrix(root);
  const configured = readChecks(root);
  const targets: (TargetSelection & { path: string; os: string; architecture: string; environment: string })[] = [
    ...matrix.native.include.map((entry) => ({
      kind: "native" as const,
      path: entry.path,
      os: entry.os,
      architecture: entry.architecture,
      environment: "native",
      release: configured.some(
        (check) =>
          (relative(root, check.directory).replaceAll("\\", "/") || ".") === entry.path && check.role === "release",
      ),
    })),
    ...matrix.compatibility.include.map((entry) => ({
      kind: "compatibility" as const,
      path: entry.path,
      os: "linux",
      architecture: entry.architecture ?? "x64",
      environment: "native",
      runtime: entry.runtime,
      version: entry.version,
      roles: entry.roles ?? ["test"],
      release: false as const,
    })),
    ...[
      ...matrix.environments.include,
      ...matrix.devcontainer.paths.map((path) => ({ path, environment: "devcontainer" })),
    ].map((entry) => ({
      kind: "environment" as const,
      path: entry.path,
      os: "linux",
      architecture: "x64",
      environment: entry.environment,
      release: false as const,
    })),
  ];
  return targets.map((target) => {
    const compiler = target.runtime === "clang" || target.runtime === "gcc";
    const phases = targetPhases(target);
    const selections = compiler
      ? target.roles.map((role) => ({ role }))
      : [{ stage: "ci" }, ...(target.release ? [{ role: "release" }, { role: "release-verify" }] : [])];
    const checks =
      target.kind === "compatibility" && !compiler
        ? compatibilityChecks(root, target.path, configured).map(({ name, role, command, source }) => ({
            name,
            role,
            command: compatibilityArguments(command, target.runtime, target.version),
            source,
          }))
        : selections.flatMap((selection) =>
            planChecks(root, configured, {
              ...selection,
              path: target.path,
              environment: target.environment,
              operatingSystem: target.os,
            }).sessions.flatMap((session) =>
              session.checks.map(({ name, role, command, source }) => ({ name, role, command, source })),
            ),
          );
    return {
      ...target,
      id: [target.kind, target.os, target.architecture, target.environment, target.runtime, target.version, target.path]
        .filter((part) => part !== undefined)
        .map(encodeURIComponent)
        .join(":"),
      checks,
      phases,
    };
  });
}

export function printCITargets(targets: CITarget[]): void {
  console.log(
    terminalTable(
      ["TARGET", "ROOT", "PLATFORM", "ENVIRONMENT", "VERSION"],
      targets.map((target) => [
        target.id,
        target.path,
        `${target.os}/${target.architecture}`,
        target.environment,
        target.runtime ? `${target.runtime} ${target.version}` : "development pins",
      ]),
    ),
  );
}

/** Group setup work while retaining every configured root and exact target. */
export function groupedCIMatrix(matrix: ReturnType<typeof ciMatrix>) {
  function group<T extends { path: string }>(entries: T[], fields: string[]) {
    const groups = new Map<string, T & { paths: string[]; msvc: boolean }>();
    for (const entry of entries) {
      const values = entry as Record<string, unknown>;
      const key = JSON.stringify(fields.map((field) => values[field] ?? ""));
      let target = groups.get(key);
      if (!target) {
        target = { ...entry, paths: [], msvc: false };
        groups.set(key, target);
      }
      if (!target.paths.includes(entry.path)) target.paths.push(entry.path);
      target.msvc ||= [values.llvm, values.rust].some(Boolean);
    }
    return [...groups.values()];
  }
  return {
    ...matrix,
    native: { include: group(matrix.native.include, ["os", "architecture", "runner", "node"]) },
    compatibility: {
      include: group(matrix.compatibility.include, ["runtime", "version", "architecture", "runner", "node", "roles"]),
    },
    environments: { include: group(matrix.environments.include, ["environment", "node"]) },
  };
}
