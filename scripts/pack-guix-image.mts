import { isRecord } from "./values.mjs";
export interface GuixImageDefinition {
  entry_point: string;
  local_state: boolean;
  symlinks: Record<string, string>;
  materialize: string[];
}
import { readFileSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { withManagedProcesses } from "./managed-process.mjs";

function assertGuixImageDefinition(value: unknown, path: string): asserts value is GuixImageDefinition {
  const relative = (path: unknown) =>
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    posix.normalize(path) === path &&
    !path.split("/").includes("..") &&
    !Array.from({ length: path.length }, (_, index) => path.charCodeAt(index)).some(
      (code) => code < 32 || code === 127 || code === 92 || code === 61,
    );
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["entry_point", "local_state", "symlinks", "materialize"].includes(key)) ||
    !relative(value.entry_point) ||
    typeof value.local_state !== "boolean" ||
    !isRecord(value.symlinks) ||
    Object.entries(value.symlinks).some(
      ([path, target]) => !path.startsWith("/") || !relative(path.slice(1)) || !relative(target),
    ) ||
    !Array.isArray(value.materialize) ||
    new Set(value.materialize).size !== value.materialize.length ||
    value.materialize.some((path: unknown) => typeof path !== "string" || !["/etc/passwd", "/etc/group"].includes(path))
  )
    throw new Error(`${path}: invalid Guix image definition`);
}

/** Image contents are declared independently of scheduling, stores, Docker transport, and verification. */
export function guixImageDefinition(root: string): GuixImageDefinition {
  const path = join(root, ".devcontainer/guix/image.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertGuixImageDefinition(value, path);
  return value;
}

export function guixPackArguments(definition: GuixImageDefinition, env: NodeJS.ProcessEnv) {
  if (!/^[a-f0-9]{64}$/.test(env.WORKBENCH_IMAGE_INPUTS ?? ""))
    throw new Error("Guix pack requires selected image inputs");
  for (const name of ["WORKBENCH_MANAGED_CORES", "WORKBENCH_MANAGED_JOBS"])
    if (!/^[1-9][0-9]*$/.test(env[name] ?? "")) throw new Error(`Guix pack requires ${name}`);
  const output = env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
  return [
    "pack",
    `--cores=${String(env.WORKBENCH_MANAGED_CORES)}`,
    `--max-jobs=${String(env.WORKBENCH_MANAGED_JOBS)}`,
    `--root=${env.WORKBENCH_MANAGED_IMAGE_ROOT ?? join(output, "image-root")}`,
    "--format=docker",
    "--compression=none",
    ...(definition.local_state ? ["--localstatedir"] : []),
    `--entry-point=${definition.entry_point}`,
    `--image-tag=workbench-guix-prepared-${String(env.WORKBENCH_IMAGE_INPUTS)}`,
    ...Object.entries(definition.symlinks).map(([path, target]) => `--symlink=${path}=${target}`),
    "--manifest=.devcontainer/guix/image.scm",
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const definition = guixImageDefinition(process.cwd());
  const runtime = process.env.WORKBENCH_GUIX_TIME_MACHINE_PROFILE ?? "/opt/workbench-guix";
  await withManagedProcesses(async (scope) => {
    const archive = await scope.run(join(runtime, "bin/guix"), guixPackArguments(definition, process.env), {
      capture: true,
    });
    writeFileSync(join(process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output", "image-path"), archive + "\n");
  });
}
