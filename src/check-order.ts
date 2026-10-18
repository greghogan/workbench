import { resolve, sep } from "node:path";
import { readConfig, type CheckOrderDefinition } from "./core.js";
import { InvalidInput } from "./input-errors.js";
import { relativePath } from "./paths.js";

export interface OrderedCheckSession {
  directory: string;
  environment: string;
  checks: readonly { role: string }[];
}

export interface CheckDependency {
  session: number;
  phase: "setup" | "complete";
}

const ancestor = (parent: string, child: string) =>
  parent !== child && child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/** Ordering constrains selected work; it never selects additional roots. */
export function checkGroupDependencies(
  root: string,
  sessions: readonly OrderedCheckSession[],
  ordering: readonly CheckOrderDefinition[],
  automatic: boolean,
): CheckDependency[][] {
  const rules = ordering.map((rule) => ({ ...rule, root: resolve(root, rule.root), after: resolve(root, rule.after) }));
  const dependencies = sessions.map((session, index) =>
    sessions.flatMap((candidate, other): CheckDependency[] => {
      if (other === index) return [];
      if (candidate.directory === session.directory)
        return other < index ? [{ session: other, phase: "complete" }] : [];
      const rule = rules.find((entry) => entry.root === session.directory && entry.after === candidate.directory);
      if (!rule && !ancestor(candidate.directory, session.directory)) return [];
      const setup =
        rule?.phase === "setup" &&
        automatic &&
        candidate.environment === session.environment &&
        candidate.checks.some((check) => check.role === "setup");
      return [{ session: other, phase: setup ? "setup" : "complete" }];
    }),
  );
  const pending = new Set(sessions.map((_, index) => index));
  while (pending.size) {
    const before = pending.size;
    for (const index of pending)
      if (!dependencies[index]?.some((dependency) => pending.has(dependency.session))) pending.delete(index);
    if (pending.size === before) throw new InvalidInput("check_order: ordering contains a cycle");
  }
  return dependencies;
}

/** Validate the complete configured graph even when a caller selects only one root. */
export function readCheckOrder(root: string, checks: readonly { directory: string }[]): CheckOrderDefinition[] {
  const ordering = readConfig(root).check_order ?? [];
  const directories = new Set(checks.map((check) => check.directory));
  const pairs = new Set<string>();
  for (const rule of ordering) {
    for (const key of ["root", "after"] as const) {
      if (typeof rule[key] !== "string") throw new InvalidInput(`check_order: ${key} is required`);
      relativePath(rule[key], `check_order.${key}`, true);
      if (!directories.has(resolve(root, rule[key])))
        throw new InvalidInput(`check_order: unknown check root '${rule[key]}'`);
    }
    if (!Object.hasOwn(rule, "phase")) throw new InvalidInput("check_order: phase is required");
    if (rule.root === rule.after) throw new InvalidInput(`check_order: '${rule.root}' cannot follow itself`);
    const pair = JSON.stringify([rule.root, rule.after]);
    if (pairs.has(pair))
      throw new InvalidInput(`check_order: duplicate ordering for '${rule.root}' after '${rule.after}'`);
    pairs.add(pair);
  }
  checkGroupDependencies(
    root,
    [...directories].map((directory) => ({ directory, environment: "", checks: [] })),
    ordering,
    false,
  );
  return ordering;
}
