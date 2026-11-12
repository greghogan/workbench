// Generated from prepare-guix-profiles.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { required, strings } from "../app/src/core/runtime/values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  guixChannelGroups,
  validateManagedPlan
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { managedSystem, writeGuixSystemFile } from "../app/src/core/execution/environments/managed/managed-system.mjs";
function link(target, path) {
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    symlinkSync(realpathSync(target), temporary);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
async function prepareGuixProfiles(value, scope) {
  const plan = validateManagedPlan(value);
  if (plan.builder !== "guix") throw new Error("Expected Guix preparation plan");
  const groups = required(plan.guix, "Missing Guix channel groups");
  const runtimeProfile = required(plan.runtime, "Missing Guix runtime");
  const profiles = new Array(plan.roots.length);
  const options = [`--cores=${String(plan.cores)}`, `--max-jobs=${String(plan.maxJobs)}`];
  const bootstrap = join(import.meta.dirname, "ci-guix-bootstrap.scm");
  for (const group of groups)
    scope.defer(() => {
      rmSync(group.imageRoot, { force: true });
    });
  for (let offset = 0; offset < groups.length; offset += plan.maxJobs) {
    const results = await Promise.allSettled(
      groups.slice(offset, offset + plan.maxJobs).map(async (group, position) => {
        const index = offset + position;
        const manager = await scope.run("guix", ["time-machine", "-C", group.channels, ...options], { capture: true });
        link(manager, group.manager);
        const guix = join(group.manager, "bin/guix");
        await scope.run(guix, ["repl", bootstrap, "register-roots", group.manager]);
        const runtime = plan.system === managedSystem(process.arch) ? manager : await scope.run(
          guix,
          ["repl", bootstrap, "profile-for-system", group.channels, plan.system, String(plan.cores)],
          { capture: true }
        );
        link(runtime, group.runtime);
        await scope.run(guix, ["repl", bootstrap, "register-roots", group.runtime]);
        const rootsFile = join(plan.output, `guix-roots-${String(index)}.json`);
        writeFileSync(
          rootsFile,
          JSON.stringify(group.roots.map((root) => required(plan.roots[root], "Missing Guix root").path))
        );
        const env = {
          ...process.env,
          GUIX_BUILD_OPTIONS: void 0,
          WORKBENCH_ROOTS_FILE: rootsFile,
          WORKBENCH_GUIX_PROFILES_FILE: void 0,
          WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(group.runtime)
        };
        rmSync(group.imageRoot, { force: true });
        const definition = join(plan.output, `guix-environments-${String(index)}.scm`);
        writeGuixSystemFile(definition, join(process.cwd(), ".devcontainer/guix/environments.scm"), plan.system);
        const environments = await scope.run(
          guix,
          ["build", ...options, `--system=${plan.system}`, `--root=${group.imageRoot}`, "-f", definition],
          { capture: true, env }
        );
        for (const [local, root] of group.roots.entries()) {
          const profile = required(plan.roots[root], "Missing Guix root");
          link(join(environments, "share/workbench/environments", String(local)), profile.profile);
          profiles[root] = {
            path: profile.path,
            profile: realpathSync(profile.profile),
            runtime: realpathSync(group.runtime),
            manager: realpathSync(group.manager)
          };
        }
        await scope.run(guix, [
          "repl",
          bootstrap,
          "register-roots",
          ...group.roots.map((root) => required(plan.roots[root], "Missing Guix root").profile)
        ]);
        rmSync(group.imageRoot, { force: true });
      })
    );
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
  }
  const file = join(plan.output, "guix-profiles.json");
  writeFileSync(file, JSON.stringify(profiles));
  writeFileSync(join(plan.output, "guix-runtime"), realpathSync(runtimeProfile));
  writeFileSync(join(plan.output, "guix-manager"), realpathSync(required(groups[0], "Missing Guix group").manager));
  return {
    ...process.env,
    GUIX_BUILD_OPTIONS: void 0,
    WORKBENCH_GUIX_PROFILES_FILE: file,
    WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(runtimeProfile),
    WORKBENCH_GUIX_MANAGER: realpathSync(required(groups[0], "Missing Guix group").manager)
  };
}
if (isMainScript(import.meta.url)) {
  const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
  const paths = strings(
    JSON.parse(readFileSync(required(process.env.WORKBENCH_ROOTS_FILE, "Missing roots file"), "utf8")),
    "Invalid managed roots"
  );
  const roots = paths.map((path, index) => ({
    path,
    profile: join(output, "profiles", String(index))
  }));
  mkdirSync(join(output, "profiles"), { recursive: true });
  const guix = guixChannelGroups(process.cwd(), roots).map((group, index) => ({
    ...group,
    manager: join(output, `manager-${String(index)}`),
    runtime: join(output, `runtime-${String(index)}`),
    imageRoot: join(output, `environments-${String(index)}`)
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
    imageRoot: join(output, "image-root")
  });
  await withManagedProcesses(async (scope) => {
    await prepareGuixProfiles(plan, scope);
  });
}
export {
  prepareGuixProfiles
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZ3VpeC1wcm9maWxlcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNNYWluU2NyaXB0IH0gZnJvbSBcIi4vc2NyaXB0LWVudHJ5Lm1qc1wiO1xuaW1wb3J0IHsgcmVxdWlyZWQsIHN0cmluZ3MgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgdHlwZSBNYW5hZ2VkUHJvY2Vzc1Njb3BlLCB3aXRoTWFuYWdlZFByb2Nlc3NlcyB9IGZyb20gXCIuL21hbmFnZWQtcHJvY2Vzcy5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHN5bWxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jLCBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7XG4gIGd1aXhDaGFubmVsR3JvdXBzLFxuICB2YWxpZGF0ZU1hbmFnZWRQbGFuLFxufSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9lbnZpcm9ubWVudHMvbWFuYWdlZC9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgbWFuYWdlZFN5c3RlbSwgd3JpdGVHdWl4U3lzdGVtRmlsZSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2Vudmlyb25tZW50cy9tYW5hZ2VkL21hbmFnZWQtc3lzdGVtLm1qc1wiO1xuXG5mdW5jdGlvbiBsaW5rKHRhcmdldDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpIHtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gYCR7cGF0aH0uJHtyYW5kb21VVUlEKCl9LnBhcnRpYWxgO1xuICB0cnkge1xuICAgIHN5bWxpbmtTeW5jKHJlYWxwYXRoU3luYyh0YXJnZXQpLCB0ZW1wb3JhcnkpO1xuICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcG9yYXJ5LCB7IGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbi8qKiBFdmFsdWF0ZSBlYWNoIGdyb3VwIHdpdGggaXRzIHBpbm5lZCBHdWl4OyBvbmx5IHJlYWxpemVkIHN0b3JlIHByb2ZpbGVzIGNyb3NzIGludG8gZmluYWwgaW1hZ2UgYXNzZW1ibHkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJlcGFyZUd1aXhQcm9maWxlcyh2YWx1ZTogdW5rbm93biwgc2NvcGU6IE1hbmFnZWRQcm9jZXNzU2NvcGUpIHtcbiAgY29uc3QgcGxhbiA9IHZhbGlkYXRlTWFuYWdlZFBsYW4odmFsdWUpO1xuICBpZiAocGxhbi5idWlsZGVyICE9PSBcImd1aXhcIikgdGhyb3cgbmV3IEVycm9yKFwiRXhwZWN0ZWQgR3VpeCBwcmVwYXJhdGlvbiBwbGFuXCIpO1xuICBjb25zdCBncm91cHMgPSByZXF1aXJlZChwbGFuLmd1aXgsIFwiTWlzc2luZyBHdWl4IGNoYW5uZWwgZ3JvdXBzXCIpO1xuICBjb25zdCBydW50aW1lUHJvZmlsZSA9IHJlcXVpcmVkKHBsYW4ucnVudGltZSwgXCJNaXNzaW5nIEd1aXggcnVudGltZVwiKTtcbiAgY29uc3QgcHJvZmlsZXMgPSBuZXcgQXJyYXk8eyBwYXRoOiBzdHJpbmc7IHByb2ZpbGU6IHN0cmluZzsgcnVudGltZTogc3RyaW5nOyBtYW5hZ2VyOiBzdHJpbmcgfT4ocGxhbi5yb290cy5sZW5ndGgpO1xuICBjb25zdCBvcHRpb25zID0gW2AtLWNvcmVzPSR7U3RyaW5nKHBsYW4uY29yZXMpfWAsIGAtLW1heC1qb2JzPSR7U3RyaW5nKHBsYW4ubWF4Sm9icyl9YF07XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGpvaW4oaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCJjaS1ndWl4LWJvb3RzdHJhcC5zY21cIik7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKVxuICAgIHNjb3BlLmRlZmVyKCgpID0+IHtcbiAgICAgIHJtU3luYyhncm91cC5pbWFnZVJvb3QsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSk7XG4gIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IGdyb3Vwcy5sZW5ndGg7IG9mZnNldCArPSBwbGFuLm1heEpvYnMpIHtcbiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKFxuICAgICAgZ3JvdXBzLnNsaWNlKG9mZnNldCwgb2Zmc2V0ICsgcGxhbi5tYXhKb2JzKS5tYXAoYXN5bmMgKGdyb3VwLCBwb3NpdGlvbjogbnVtYmVyKSA9PiB7XG4gICAgICAgIGNvbnN0IGluZGV4ID0gb2Zmc2V0ICsgcG9zaXRpb247XG4gICAgICAgIGNvbnN0IG1hbmFnZXIgPSBhd2FpdCBzY29wZS5ydW4oXCJndWl4XCIsIFtcInRpbWUtbWFjaGluZVwiLCBcIi1DXCIsIGdyb3VwLmNoYW5uZWxzLCAuLi5vcHRpb25zXSwgeyBjYXB0dXJlOiB0cnVlIH0pO1xuICAgICAgICBsaW5rKG1hbmFnZXIsIGdyb3VwLm1hbmFnZXIpO1xuICAgICAgICBjb25zdCBndWl4ID0gam9pbihncm91cC5tYW5hZ2VyLCBcImJpbi9ndWl4XCIpO1xuICAgICAgICBhd2FpdCBzY29wZS5ydW4oZ3VpeCwgW1wicmVwbFwiLCBib290c3RyYXAsIFwicmVnaXN0ZXItcm9vdHNcIiwgZ3JvdXAubWFuYWdlcl0pO1xuICAgICAgICBjb25zdCBydW50aW1lID1cbiAgICAgICAgICBwbGFuLnN5c3RlbSA9PT0gbWFuYWdlZFN5c3RlbShwcm9jZXNzLmFyY2gpXG4gICAgICAgICAgICA/IG1hbmFnZXJcbiAgICAgICAgICAgIDogYXdhaXQgc2NvcGUucnVuKFxuICAgICAgICAgICAgICAgIGd1aXgsXG4gICAgICAgICAgICAgICAgW1wicmVwbFwiLCBib290c3RyYXAsIFwicHJvZmlsZS1mb3Itc3lzdGVtXCIsIGdyb3VwLmNoYW5uZWxzLCBwbGFuLnN5c3RlbSwgU3RyaW5nKHBsYW4uY29yZXMpXSxcbiAgICAgICAgICAgICAgICB7IGNhcHR1cmU6IHRydWUgfSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgbGluayhydW50aW1lLCBncm91cC5ydW50aW1lKTtcbiAgICAgICAgYXdhaXQgc2NvcGUucnVuKGd1aXgsIFtcInJlcGxcIiwgYm9vdHN0cmFwLCBcInJlZ2lzdGVyLXJvb3RzXCIsIGdyb3VwLnJ1bnRpbWVdKTtcbiAgICAgICAgY29uc3Qgcm9vdHNGaWxlID0gam9pbihwbGFuLm91dHB1dCwgYGd1aXgtcm9vdHMtJHtTdHJpbmcoaW5kZXgpfS5qc29uYCk7XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgcm9vdHNGaWxlLFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGdyb3VwLnJvb3RzLm1hcCgocm9vdDogbnVtYmVyKSA9PiByZXF1aXJlZChwbGFuLnJvb3RzW3Jvb3RdLCBcIk1pc3NpbmcgR3VpeCByb290XCIpLnBhdGgpKSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgZW52ID0ge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIEdVSVhfQlVJTERfT1BUSU9OUzogdW5kZWZpbmVkLFxuICAgICAgICAgIFdPUktCRU5DSF9ST09UU19GSUxFOiByb290c0ZpbGUsXG4gICAgICAgICAgV09SS0JFTkNIX0dVSVhfUFJPRklMRVNfRklMRTogdW5kZWZpbmVkLFxuICAgICAgICAgIFdPUktCRU5DSF9HVUlYX1RJTUVfTUFDSElORV9QUk9GSUxFOiByZWFscGF0aFN5bmMoZ3JvdXAucnVudGltZSksXG4gICAgICAgIH07XG4gICAgICAgIHJtU3luYyhncm91cC5pbWFnZVJvb3QsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgIGNvbnN0IGRlZmluaXRpb24gPSBqb2luKHBsYW4ub3V0cHV0LCBgZ3VpeC1lbnZpcm9ubWVudHMtJHtTdHJpbmcoaW5kZXgpfS5zY21gKTtcbiAgICAgICAgd3JpdGVHdWl4U3lzdGVtRmlsZShkZWZpbml0aW9uLCBqb2luKHByb2Nlc3MuY3dkKCksIFwiLmRldmNvbnRhaW5lci9ndWl4L2Vudmlyb25tZW50cy5zY21cIiksIHBsYW4uc3lzdGVtKTtcbiAgICAgICAgY29uc3QgZW52aXJvbm1lbnRzID0gYXdhaXQgc2NvcGUucnVuKFxuICAgICAgICAgIGd1aXgsXG4gICAgICAgICAgW1wiYnVpbGRcIiwgLi4ub3B0aW9ucywgYC0tc3lzdGVtPSR7cGxhbi5zeXN0ZW19YCwgYC0tcm9vdD0ke2dyb3VwLmltYWdlUm9vdH1gLCBcIi1mXCIsIGRlZmluaXRpb25dLFxuICAgICAgICAgIHsgY2FwdHVyZTogdHJ1ZSwgZW52IH0sXG4gICAgICAgICk7XG4gICAgICAgIGZvciAoY29uc3QgW2xvY2FsLCByb290XSBvZiBncm91cC5yb290cy5lbnRyaWVzKCkpIHtcbiAgICAgICAgICBjb25zdCBwcm9maWxlID0gcmVxdWlyZWQocGxhbi5yb290c1tyb290XSwgXCJNaXNzaW5nIEd1aXggcm9vdFwiKTtcbiAgICAgICAgICBsaW5rKGpvaW4oZW52aXJvbm1lbnRzLCBcInNoYXJlL3dvcmtiZW5jaC9lbnZpcm9ubWVudHNcIiwgU3RyaW5nKGxvY2FsKSksIHByb2ZpbGUucHJvZmlsZSk7XG4gICAgICAgICAgcHJvZmlsZXNbcm9vdF0gPSB7XG4gICAgICAgICAgICBwYXRoOiBwcm9maWxlLnBhdGgsXG4gICAgICAgICAgICBwcm9maWxlOiByZWFscGF0aFN5bmMocHJvZmlsZS5wcm9maWxlKSxcbiAgICAgICAgICAgIHJ1bnRpbWU6IHJlYWxwYXRoU3luYyhncm91cC5ydW50aW1lKSxcbiAgICAgICAgICAgIG1hbmFnZXI6IHJlYWxwYXRoU3luYyhncm91cC5tYW5hZ2VyKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHNjb3BlLnJ1bihndWl4LCBbXG4gICAgICAgICAgXCJyZXBsXCIsXG4gICAgICAgICAgYm9vdHN0cmFwLFxuICAgICAgICAgIFwicmVnaXN0ZXItcm9vdHNcIixcbiAgICAgICAgICAuLi5ncm91cC5yb290cy5tYXAoKHJvb3Q6IG51bWJlcikgPT4gcmVxdWlyZWQocGxhbi5yb290c1tyb290XSwgXCJNaXNzaW5nIEd1aXggcm9vdFwiKS5wcm9maWxlKSxcbiAgICAgICAgXSk7XG4gICAgICAgIHJtU3luYyhncm91cC5pbWFnZVJvb3QsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9KSxcbiAgICApO1xuICAgIGNvbnN0IGZhaWx1cmVzID0gcmVzdWx0cy5maWx0ZXIoKHJlc3VsdCkgPT4gcmVzdWx0LnN0YXR1cyA9PT0gXCJyZWplY3RlZFwiKS5tYXAoKHJlc3VsdCk6IHVua25vd24gPT4gcmVzdWx0LnJlYXNvbik7XG4gICAgaWYgKGZhaWx1cmVzLmxlbmd0aCkgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGZhaWx1cmVzLCBmYWlsdXJlcy5tYXAoU3RyaW5nKS5qb2luKFwiOyBcIikpO1xuICB9XG4gIGNvbnN0IGZpbGUgPSBqb2luKHBsYW4ub3V0cHV0LCBcImd1aXgtcHJvZmlsZXMuanNvblwiKTtcbiAgd3JpdGVGaWxlU3luYyhmaWxlLCBKU09OLnN0cmluZ2lmeShwcm9maWxlcykpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbi5vdXRwdXQsIFwiZ3VpeC1ydW50aW1lXCIpLCByZWFscGF0aFN5bmMocnVudGltZVByb2ZpbGUpKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW4ub3V0cHV0LCBcImd1aXgtbWFuYWdlclwiKSwgcmVhbHBhdGhTeW5jKHJlcXVpcmVkKGdyb3Vwc1swXSwgXCJNaXNzaW5nIEd1aXggZ3JvdXBcIikubWFuYWdlcikpO1xuICByZXR1cm4ge1xuICAgIC4uLnByb2Nlc3MuZW52LFxuICAgIEdVSVhfQlVJTERfT1BUSU9OUzogdW5kZWZpbmVkLFxuICAgIFdPUktCRU5DSF9HVUlYX1BST0ZJTEVTX0ZJTEU6IGZpbGUsXG4gICAgV09SS0JFTkNIX0dVSVhfVElNRV9NQUNISU5FX1BST0ZJTEU6IHJlYWxwYXRoU3luYyhydW50aW1lUHJvZmlsZSksXG4gICAgV09SS0JFTkNIX0dVSVhfTUFOQUdFUjogcmVhbHBhdGhTeW5jKHJlcXVpcmVkKGdyb3Vwc1swXSwgXCJNaXNzaW5nIEd1aXggZ3JvdXBcIikubWFuYWdlciksXG4gIH07XG59XG5cbi8vIFRoZSBmYWxsYmFjayBidWlsZGVyIGhhcyBpdHMgb3duIHBlcnNpc3RlbnQgc3RvcmU7IGl0cyB0ZW1wb3JhcnkgbGlua3MgYmVsb25nIHRvIHRoYXQgYnVpbGRlcidzIG91dHB1dCBkaXJlY3RvcnkuXG5pZiAoaXNNYWluU2NyaXB0KGltcG9ydC5tZXRhLnVybCkpIHtcbiAgY29uc3Qgb3V0cHV0ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfT1VUUFVUID8/IFwiL291dHB1dFwiO1xuICBjb25zdCBwYXRocyA9IHN0cmluZ3MoXG4gICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVxdWlyZWQocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1JPT1RTX0ZJTEUsIFwiTWlzc2luZyByb290cyBmaWxlXCIpLCBcInV0ZjhcIikpLFxuICAgIFwiSW52YWxpZCBtYW5hZ2VkIHJvb3RzXCIsXG4gICk7XG4gIGNvbnN0IHJvb3RzID0gcGF0aHMubWFwKChwYXRoLCBpbmRleCkgPT4gKHtcbiAgICBwYXRoLFxuICAgIHByb2ZpbGU6IGpvaW4ob3V0cHV0LCBcInByb2ZpbGVzXCIsIFN0cmluZyhpbmRleCkpLFxuICB9KSk7XG4gIG1rZGlyU3luYyhqb2luKG91dHB1dCwgXCJwcm9maWxlc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGd1aXggPSBndWl4Q2hhbm5lbEdyb3Vwcyhwcm9jZXNzLmN3ZCgpLCByb290cykubWFwKChncm91cCwgaW5kZXgpID0+ICh7XG4gICAgLi4uZ3JvdXAsXG4gICAgbWFuYWdlcjogam9pbihvdXRwdXQsIGBtYW5hZ2VyLSR7U3RyaW5nKGluZGV4KX1gKSxcbiAgICBydW50aW1lOiBqb2luKG91dHB1dCwgYHJ1bnRpbWUtJHtTdHJpbmcoaW5kZXgpfWApLFxuICAgIGltYWdlUm9vdDogam9pbihvdXRwdXQsIGBlbnZpcm9ubWVudHMtJHtTdHJpbmcoaW5kZXgpfWApLFxuICB9KSk7XG4gIGNvbnN0IHBsYW4gPSB2YWxpZGF0ZU1hbmFnZWRQbGFuKHtcbiAgICBidWlsZGVyOiBcImd1aXhcIixcbiAgICBzeXN0ZW06IG1hbmFnZWRTeXN0ZW0oKSxcbiAgICBjb3JlczogTnVtYmVyKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPUkVTKSxcbiAgICBtYXhKb2JzOiBOdW1iZXIocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfSk9CUyksXG4gICAgb3V0cHV0LFxuICAgIHJ1bnRpbWVPd25lcjogb3V0cHV0LFxuICAgIHJvb3RzLFxuICAgIGd1aXgsXG4gICAgcnVudGltZTogZ3VpeFswXT8ucnVudGltZSxcbiAgICBpbWFnZVJvb3Q6IGpvaW4ob3V0cHV0LCBcImltYWdlLXJvb3RcIiksXG4gIH0pO1xuICBhd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgICBhd2FpdCBwcmVwYXJlR3VpeFByb2ZpbGVzKHBsYW4sIHNjb3BlKTtcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFVBQVUsZUFBZTtBQUNsQyxTQUFtQyw0QkFBNEI7QUFDL0QsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxjQUFjLGNBQWMsWUFBWSxRQUFRLGFBQWEsZUFBZSxpQkFBaUI7QUFDdEcsU0FBUyxZQUFZO0FBQ3JCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxlQUFlLDJCQUEyQjtBQUVuRCxTQUFTLEtBQUssUUFBZ0IsTUFBYztBQUMxQyxRQUFNLFlBQVksR0FBRyxJQUFJLElBQUksV0FBVyxDQUFDO0FBQ3pDLE1BQUk7QUFDRixnQkFBWSxhQUFhLE1BQU0sR0FBRyxTQUFTO0FBQzNDLGVB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RSxPQUFPLENBQUM7QUFDaEgsU0FBTztBQUFBLElBQ0wsR0FBRyxRQUFRO0FBQUEsSUFDWCxvQkFBb0I7QUFBQSxJQUNwQiw4QkFBOEI7QUFBQSxJQUM5QixxQ0FBcUMsYUFBYSxjQUFjO0FBQUEsSUFDaEUsd0JBQXdCLGFBQWEsU0FBUyxPQUFPLENBQUMsR0FBRyxvQkFBb0IsRUFBRSxPQUFPO0FBQUEsRUFDeEY7QUFDRjtBQUdBLElBQUksYUFBYSxZQUFZLEdBQUcsR0FBRztBQUNqQyxRQUFNLFNBQVMsUUFBUSxJQUFJLDRCQUE0QjtBQUN2RCxRQUFNLFFBQVE7QUFBQSxJQUNaLEtBQUssTUFBTSxhQUFhLFNBQVMsUUFBUSxJQUFJLHNCQUFzQixvQkFBb0IsR0FBRyxNQUFNLENBQUM7QUFBQSxJQUNqRztBQUFBLEVBQ0Y7QUFDQSxRQUFNLFFBQVEsTUFBTSxJQUFJLENBQUMsTUFBTSxXQUFXO0FBQUEsSUFDeEM7QUFBQSxJQUNBLFNBQVMsS0FBSyxRQUFRLFlBQVksT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNqRCxFQUFFO0FBQ0YsWUFBVSxLQUFLLFFBQVEsVUFBVSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkQsUUFBTSxPQUFPLGtCQUFrQixRQUFRLElBQUksR0FBRyxLQUFLLEVBQUUsSUFBSSxDQUFDLE9BQU8sV0FBVztBQUFBLElBQzFFLEdBQUc7QUFBQSxJQUNILFNBQVMsS0FBSyxRQUFRLFdBQVcsT0FBTyxLQUFLLENBQUMsRUFBRTtBQUFBLElBQ2hELFNBQVMsS0FBSyxRQUFRLFdBQVcsT0FBTyxLQUFLLENBQUMsRUFBRTtBQUFBLElBQ2hELFdBQVcsS0FBSyxRQUFRLGdCQUFnQixPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQUEsRUFDekQsRUFBRTtBQUNGLFFBQU0sT0FBTyxvQkFBb0I7QUFBQSxJQUMvQixTQUFTO0FBQUEsSUFDVCxRQUFRLGNBQWM7QUFBQSxJQUN0QixPQUFPLE9BQU8sUUFBUSxJQUFJLHVCQUF1QjtBQUFBLElBQ2pELFNBQVMsT0FBTyxRQUFRLElBQUksc0JBQXNCO0FBQUEsSUFDbEQ7QUFBQSxJQUNBLGNBQWM7QUFBQSxJQUNkO0FBQUEsSUFDQTtBQUFBLElBQ0EsU0FBUyxLQUFLLENBQUMsR0FBRztBQUFBLElBQ2xCLFdBQVcsS0FBSyxRQUFRLFlBQVk7QUFBQSxFQUN0QyxDQUFDO0FBQ0QsUUFBTSxxQkFBcUIsT0FBTyxVQUFVO0FBQzFDLFVBQU0sb0JBQW9CLE1BQU0sS0FBSztBQUFBLEVBQ3ZDLENBQUM7QUFDSDsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3ByZXBhcmUtZ3VpeC1wcm9maWxlcy5tanMifQ==
