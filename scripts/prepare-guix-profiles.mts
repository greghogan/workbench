import { required, strings } from "./values.mjs";
import type { ManagedProcessScope } from "./managed-process.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { guixChannelGroups, validateManagedPlan } from "./managed-contract.mjs";
import { withManagedProcesses } from "./managed-process.mjs";

function link(target: string, path: string) {
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    symlinkSync(realpathSync(target), temporary);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Evaluate each group with its pinned Guix; only realized store profiles cross into final image assembly. */
export async function prepareGuixProfiles(value: unknown, scope: ManagedProcessScope) {
  const plan = validateManagedPlan(value);
  if (plan.builder !== "guix") throw new Error("Expected Guix preparation plan");
  const groups = required(plan.guix, "Missing Guix channel groups");
  const runtimeProfile = required(plan.runtime, "Missing Guix runtime");
  const profiles = new Array<{ path: string; profile: string; runtime: string }>(plan.roots.length);
  const options = [`--cores=${String(plan.cores)}`, `--max-jobs=${String(plan.maxJobs)}`];
  const bootstrap = join(import.meta.dirname, "ci-guix-bootstrap.scm");
  for (const group of groups)
    scope.defer(() => {
      rmSync(group.imageRoot, { force: true });
    });
  for (let offset = 0; offset < groups.length; offset += plan.maxJobs) {
    const results = await Promise.allSettled(
      groups.slice(offset, offset + plan.maxJobs).map(async (group, position: number) => {
        const index = offset + position;
        const runtime = await scope.run("guix", ["time-machine", "-C", group.channels, ...options], { capture: true });
        link(runtime, group.runtime);
        const guix = join(group.runtime, "bin/guix");
        await scope.run(guix, ["repl", bootstrap, "register-roots", group.runtime]);
        const rootsFile = join(plan.output, `guix-roots-${String(index)}.json`);
        writeFileSync(
          rootsFile,
          JSON.stringify(group.roots.map((root: number) => required(plan.roots[root], "Missing Guix root").path)),
        );
        const env = {
          ...process.env,
          WORKBENCH_ROOTS_FILE: rootsFile,
          WORKBENCH_GUIX_PROFILES_FILE: undefined,
          WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(group.runtime),
        };
        rmSync(group.imageRoot, { force: true });
        const environments = await scope.run(
          guix,
          ["build", ...options, `--root=${group.imageRoot}`, "-f", ".devcontainer/guix/environments.scm"],
          { capture: true, env },
        );
        for (const [local, root] of group.roots.entries()) {
          const profile = required(plan.roots[root], "Missing Guix root");
          link(join(environments, "share/workbench/environments", String(local)), profile.profile);
          profiles[root] = {
            path: profile.path,
            profile: realpathSync(profile.profile),
            runtime: realpathSync(group.runtime),
          };
        }
        await scope.run(guix, [
          "repl",
          bootstrap,
          "register-roots",
          ...group.roots.map((root: number) => required(plan.roots[root], "Missing Guix root").profile),
        ]);
        rmSync(group.imageRoot, { force: true });
      }),
    );
    const failures = results.filter((result) => result.status === "rejected").map((result): unknown => result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
  }
  const file = join(plan.output, "guix-profiles.json");
  writeFileSync(file, JSON.stringify(profiles));
  writeFileSync(join(plan.output, "guix-runtime"), realpathSync(runtimeProfile));
  return {
    ...process.env,
    WORKBENCH_GUIX_PROFILES_FILE: file,
    WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(runtimeProfile),
  };
}

// The fallback builder has its own persistent store; its temporary links belong to that builder's output directory.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
  const paths = strings(
    JSON.parse(readFileSync(required(process.env.WORKBENCH_ROOTS_FILE, "Missing roots file"), "utf8")),
    "Invalid managed roots",
  );
  const roots = paths.map((path, index) => ({
    path,
    profile: join(output, "profiles", String(index)),
  }));
  mkdirSync(join(output, "profiles"), { recursive: true });
  const guix = guixChannelGroups(process.cwd(), roots).map((group, index) => ({
    ...group,
    runtime: join(output, `runtime-${String(index)}`),
    imageRoot: join(output, `environments-${String(index)}`),
  }));
  const plan = validateManagedPlan({
    builder: "guix",
    cores: Number(process.env.WORKBENCH_MANAGED_CORES),
    maxJobs: Number(process.env.WORKBENCH_MANAGED_JOBS),
    output,
    runtimeOwner: output,
    roots,
    guix,
    runtime: guix[0]?.runtime,
    imageRoot: join(output, "image-root"),
  });
  await withManagedProcesses(async (scope) => {
    await prepareGuixProfiles(plan, scope);
  });
}
