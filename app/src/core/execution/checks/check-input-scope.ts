import type { CheckInputGroup } from "../../projects/project-model.js";
import { projectPaths } from "../../projects/project-paths.js";
import { InvalidInput } from "../../runtime/input-errors.js";
import type { ConfiguredCheck } from "./check-configuration.js";
import { hostOperatingSystem } from "./check-plan.js";

export interface DeclaredCheckInputs {
  groups: string[];
  paths: string[];
  outputs?: string[];
}

export type CheckInputScope =
  ({ mode: "scoped" } & DeclaredCheckInputs) | { mode: "whole-project"; reason: string; paths?: string[] };

const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort();

export function checkInputGroups(definitions: Record<string, CheckInputGroup> = {}) {
  const resolved = new Map<string, DeclaredCheckInputs>();
  const resolving = new Set<string>();

  function merge(inputs: DeclaredCheckInputs[]): DeclaredCheckInputs {
    const outputs = uniqueSorted(inputs.flatMap((input) => input.outputs ?? []));
    return {
      groups: uniqueSorted(inputs.flatMap((input) => input.groups)),
      paths: uniqueSorted(inputs.flatMap((input) => input.paths)),
      ...(outputs.length > 0 && { outputs }),
    };
  }

  function group(name: string, context: string): DeclaredCheckInputs {
    const cached = resolved.get(name);
    if (cached) return cached;
    if (!Object.hasOwn(definitions, name)) throw new InvalidInput(`${context}: unknown input group '${name}'`);
    if (resolving.has(name)) throw new InvalidInput(`input group cycle: ${[...resolving, name].join(" → ")}`);
    resolving.add(name);
    const definition = definitions[name];
    const dependencies = (definition?.depends_on ?? []).map((dependency) => group(dependency, `input group '${name}'`));
    const inputs = merge([
      {
        groups: [name],
        paths: definition?.paths ?? [],
        ...(definition?.outputs && { outputs: definition.outputs }),
      },
      ...dependencies,
    ]);
    if (!inputs.paths.length) throw new InvalidInput(`input group '${name}' must resolve to at least one path`);
    resolving.delete(name);
    resolved.set(name, inputs);
    return inputs;
  }

  for (const name of Object.keys(definitions)) group(name, "input_groups");
  return (names: readonly string[] | undefined, context: string): DeclaredCheckInputs | undefined => {
    if (!names?.length) return undefined;
    return merge(names.map((name) => group(name, context)));
  };
}

export function reusableChecks(checks: readonly ConfiguredCheck[]): readonly ConfiguredCheck[] {
  const reusable = checks.filter((check) => check.role !== "secret" && check.role !== "setup");
  return reusable.some((check) => check.requiresSetup)
    ? [...reusable, ...checks.filter((check) => check.role === "setup")]
    : reusable;
}

export function checkGateInputScope(
  sessions: readonly { checks: readonly ConfiguredCheck[] }[],
  additionalInputs: readonly string[] = [],
): CheckInputScope {
  return checkScopes(
    sessions.flatMap((session) => reusableChecks(session.checks)),
    additionalInputs,
  );
}

export function checkScopes(
  checks: readonly ConfiguredCheck[],
  additionalInputs: readonly string[] = [],
): CheckInputScope {
  const wholeProject = checks.find((check) => !check.inputs);
  const paths = uniqueSorted(checks.flatMap((check) => check.inputs?.paths ?? []));
  if (hostOperatingSystem() === "windows")
    return {
      mode: "whole-project",
      reason: "Scoped input isolation is unavailable on Windows",
      ...(paths.length && { paths }),
    };
  if (wholeProject)
    return {
      mode: "whole-project",
      reason: `No input groups for ${wholeProject.name}`,
      ...(paths.length ? { paths } : {}),
    };
  if (!checks.length) return { mode: "whole-project", reason: "No reusable checks selected" };
  const outputs = uniqueSorted(checks.flatMap((check) => check.inputs?.outputs ?? []));
  return {
    mode: "scoped",
    groups: uniqueSorted(checks.flatMap((check) => check.inputs?.groups ?? [])),
    ...(outputs.length > 0 && { outputs }),
    paths: uniqueSorted([
      projectPaths.config,
      projectPaths.projects,
      projectPaths.automation,
      projectPaths.profiles,
      ...additionalInputs,
      ...paths,
    ]),
  };
}

export function inputScopeMatcher(inputs: readonly string[]): (path: string) => boolean {
  if (inputs.includes(".")) return () => true;
  const normalize =
    process.platform === "linux" ? (value: string) => value : (value: string) => value.normalize("NFD").toLowerCase();
  const selected = new Set(inputs.map(normalize));
  return (path) => {
    let name = normalize(path);
    for (;;) {
      if (selected.has(name)) return true;
      const separator = name.lastIndexOf("/");
      if (separator < 0) return false;
      name = name.slice(0, separator);
    }
  };
}
