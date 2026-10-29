import type { Command } from "commander";
interface Admission {
  internal?: boolean;
  project?: boolean;
  registration?: boolean;
  policy?: boolean;
  explicitRoot?: boolean;
  children?: Record<string, Omit<Admission, "children">>;
}
/** Command registration, bootstrap, help, and execution share these admission contracts. */
const commands: Record<string, Admission> = {
  advisories: { project: true, registration: true },

  "build-clean": { internal: true },

  "buildkit-build": { internal: true, policy: true },

  cache: { explicitRoot: true },
  "cache-auto-prune": { internal: true, explicitRoot: true },

  check: {
    project: true,
    registration: true,
    policy: true,
    explicitRoot: true,
    children: { matrix: { policy: false } },
  },

  "checks-session": { internal: true, policy: true },

  ci: { project: true, registration: true, policy: true, children: { validate: { policy: false } } },

  "ci-cache-inspect": { internal: true },

  "ci-checks": { internal: true, policy: true },

  "ci-image-acquire": { internal: true, policy: true },

  "ci-image-exec": { internal: true, policy: true },

  citation: { project: true, registration: true },

  collection: { registration: true },

  commit: {
    project: true,
    registration: true,
    policy: true,
    children: { check: { project: false, registration: false, policy: true } },
  },

  "compatibility-exec": { internal: true, policy: true },

  complete: { internal: true, explicitRoot: true },

  completion: { explicitRoot: true },

  config: { explicitRoot: true },

  "dependency-setup": { internal: true, policy: true },

  "devcontainer-exec": { internal: true, policy: true },

  development: {
    project: true,
    registration: true,
    children: {
      profiles: { policy: false },
      images: { policy: false },
      locks: { policy: false },
      recover: { policy: true },
      use: { policy: true },
      prepare: { policy: true },
      verify: { policy: true },
      publish: { policy: true },
    },
  },

  docs: { project: true, registration: true, policy: true },

  executable: { explicitRoot: true },

  feedback: { registration: true },

  format: { project: true, registration: true },

  help: { explicitRoot: true },

  "image-finalize": { internal: true, policy: true },

  init: {},

  install: { explicitRoot: true },

  language: { registration: true, children: { roots: { project: true }, init: { project: true } } },

  logs: { explicitRoot: true },

  "managed-builder-record": { internal: true, policy: true },

  "managed-exec": { internal: true, policy: true },

  "managed-image-prepare": { internal: true, policy: true },

  "image-roots": { internal: true, policy: true },

  "managed-inputs-exec": { internal: true, policy: true },

  "miri-exec": { internal: true, policy: true },

  "native-assets-prune": { internal: true },

  "native-image-inputs": { internal: true, policy: true },

  "native-exec": { internal: true, policy: true },

  observe: { internal: true, explicitRoot: true },

  "offline-exec": { internal: true, policy: true },

  "package-manager-exec": { internal: true, policy: true },

  paths: { project: true, registration: true },

  "php-coverage-exec": { internal: true, policy: true },

  "php-package-manager-exec": { internal: true, policy: true },

  "pnpm-config": { internal: true },

  "pre-commit": { project: true, registration: true, policy: true, explicitRoot: true },

  "pre-push": { project: true, registration: true, policy: true, explicitRoot: true },

  project: { explicitRoot: true },

  record: { project: true, registration: true },
  task: { project: true, registration: true },
  experiment: { project: true, registration: true, policy: true, children: { show: { policy: false } } },
  queue: { project: true, registration: true },

  release: { project: true, registration: true, children: { profiles: { policy: false }, prepare: { policy: true } } },

  review: {
    project: true,
    registration: true,
    explicitRoot: true,
    children: { "finish-commit": { project: false, registration: false, internal: true } },
  },

  "ruby-package-manager-exec": { internal: true, policy: true },

  secrets: { registration: true, explicitRoot: true },

  serve: { registration: true, explicitRoot: true },

  "setup-project": { internal: true, explicitRoot: true },

  shell: { project: true, registration: true, policy: true },

  "shell-session": { internal: true, policy: true },

  skills: {},

  subproject: { project: true, registration: true },

  sync: { project: true, registration: true },

  tools: {
    project: true,
    registration: true,
    children: { profiles: { policy: false }, install: { policy: true }, maven: { policy: true } },
  },

  "tools-install": { internal: true, policy: true },

  update: { project: true, registration: true, policy: true, explicitRoot: true },

  "update-prepare": { internal: true, policy: true, explicitRoot: true },

  validate: { project: true, registration: true, explicitRoot: true },

  "vcpkg-prepare": { internal: true, policy: true },

  "web-collection": { internal: true },

  "web-demo": { internal: true },
};
export function commandAdmission(path: string) {
  const [top = "", ...rest] = path.split(" ");
  const base = commands[top] ?? {};
  let selected = { ...base };
  for (let depth = 1; depth <= rest.length; depth++)
    selected = { ...selected, ...base.children?.[rest.slice(0, depth).join(" ")] };
  return {
    internal: selected.internal === true,
    project: selected.project === true,
    registration: selected.registration === true,
    policy: selected.policy === true,
    explicitRoot: selected.explicitRoot === true,
  };
}
/** Validate admission at registration rather than silently introducing an unclassified command. */
export function registerCommand(parent: Command, signature: string | Command, options?: { hidden?: boolean }): Command {
  const lineage: string[] = [];
  for (let current: Command | null = parent; current.parent; current = current.parent) lineage.unshift(current.name());
  const top = lineage[0] ?? (typeof signature === "string" ? signature.split(/[ <[]/, 1)[0] : signature.name()) ?? "";
  if (!Object.hasOwn(commands, top)) throw new Error(`missing command admission contract: ${top}`);
  if (typeof signature !== "string") {
    parent.addCommand(signature, options);
    return signature;
  }
  return parent.command(signature, options);
}

/** Overrides must name registered commands; mixed execution/inspection trees classify every branch. */
export function validateCommandAdmissions(program: Command): void {
  for (const top of program.commands) {
    const base = commands[top.name()];
    if (!base) throw new Error(`missing command admission contract: ${top.name()}`);
    const paths = new Set<string>();
    const mixed =
      base.policy === undefined && Object.values(base.children ?? {}).some((value) => value.policy !== undefined);
    const visit = (command: Command, parts: string[], inherited: boolean) => {
      const path = parts.join(" ");
      paths.add(path);
      const declared = inherited || base.children?.[path]?.policy !== undefined;
      if (mixed && parts.length && !declared)
        throw new Error(`missing nested policy classification: ${top.name()} ${path}`);
      for (const child of command.commands) visit(child, [...parts, child.name()], declared);
    };
    visit(top, [], base.policy !== undefined);
    for (const path of Object.keys(base.children ?? {}))
      if (!paths.has(path)) throw new Error(`stale command admission override: ${top.name()} ${path}`);
  }
}

/** Public command ancestry excludes the program name and is shared by help and execution. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current.parent; current = current.parent) names.unshift(current.name());
  return names.join(" ");
}

/** Commander accumulator for repeatable options. */
export const collect = (value: string, previous: string[]): string[] => [...previous, value];
