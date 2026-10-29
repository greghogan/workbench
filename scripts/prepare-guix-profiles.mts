import { isMainScript } from "./script-entry.mjs";
import { required, strings } from "./values.mjs";
import { type ManagedProcessScope, withManagedProcesses } from "./managed-process.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { guixChannelGroups, validateManagedPlan } from "./managed-contract.mjs";
import { managedSystem, writeGuixSystemFile } from "./managed-system.mjs";

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
  const profiles = new Array<{ path: string; profile: string; runtime: string; manager: string }>(plan.roots.length);
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
        const manager = await scope.run("guix", ["time-machine", "-C", group.channels, ...options], { capture: true });
        link(manager, group.manager);
        const guix = join(group.manager, "bin/guix");
        await scope.run(guix, ["repl", bootstrap, "register-roots", group.manager]);
        const runtime =
          plan.system === managedSystem(process.arch)
            ? manager
            : await scope.run(
                guix,
                ["repl", bootstrap, "profile-for-system", group.channels, plan.system, String(plan.cores)],
                { capture: true },
              );
        link(runtime, group.runtime);
        await scope.run(guix, ["repl", bootstrap, "register-roots", group.runtime]);
        const rootsFile = join(plan.output, `guix-roots-${String(index)}.json`);
        writeFileSync(
          rootsFile,
          JSON.stringify(group.roots.map((root: number) => required(plan.roots[root], "Missing Guix root").path)),
        );
        const env = {
          ...process.env,
          GUIX_BUILD_OPTIONS: undefined,
          WORKBENCH_ROOTS_FILE: rootsFile,
          WORKBENCH_GUIX_PROFILES_FILE: undefined,
          WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(group.runtime),
        };
        rmSync(group.imageRoot, { force: true });
        const definition = join(plan.output, `guix-environments-${String(index)}.scm`);
        writeGuixSystemFile(definition, join(process.cwd(), ".devcontainer/guix/environments.scm"), plan.system);
        const environments = await scope.run(
          guix,
          ["build", ...options, `--system=${plan.system}`, `--root=${group.imageRoot}`, "-f", definition],
          { capture: true, env },
        );
        for (const [local, root] of group.roots.entries()) {
          const profile = required(plan.roots[root], "Missing Guix root");
          link(join(environments, "share/workbench/environments", String(local)), profile.profile);
          profiles[root] = {
            path: profile.path,
            profile: realpathSync(profile.profile),
            runtime: realpathSync(group.runtime),
            manager: realpathSync(group.manager),
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
  writeFileSync(join(plan.output, "guix-manager"), realpathSync(required(groups[0], "Missing Guix group").manager));
  return {
    ...process.env,
    GUIX_BUILD_OPTIONS: undefined,
    WORKBENCH_GUIX_PROFILES_FILE: file,
    WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(runtimeProfile),
    WORKBENCH_GUIX_MANAGER: realpathSync(required(groups[0], "Missing Guix group").manager),
  };
}

// The fallback builder has its own persistent store; its temporary links belong to that builder's output directory.
if (isMainScript(import.meta.url)) {
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
    manager: join(output, `manager-${String(index)}`),
    runtime: join(output, `runtime-${String(index)}`),
    imageRoot: join(output, `environments-${String(index)}`),
  }));
  const plan = validateManagedPlan({
    builder: "guix",
    system: managedSystem(),
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
