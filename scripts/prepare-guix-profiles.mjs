// Generated from prepare-guix-profiles.mts; edit the TypeScript source.
import { required, strings } from "./values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { guixChannelGroups, validateManagedPlan } from "./managed-contract.mjs";
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
        const runtime = await scope.run("guix", ["time-machine", "-C", group.channels, ...options], { capture: true });
        link(runtime, group.runtime);
        const guix = join(group.runtime, "bin/guix");
        await scope.run(guix, ["repl", bootstrap, "register-roots", group.runtime]);
        const rootsFile = join(plan.output, `guix-roots-${String(index)}.json`);
        writeFileSync(
          rootsFile,
          JSON.stringify(group.roots.map((root) => required(plan.roots[root], "Missing Guix root").path))
        );
        const env = {
          ...process.env,
          WORKBENCH_ROOTS_FILE: rootsFile,
          WORKBENCH_GUIX_PROFILES_FILE: void 0,
          WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(group.runtime)
        };
        rmSync(group.imageRoot, { force: true });
        const environments = await scope.run(
          guix,
          ["build", ...options, `--root=${group.imageRoot}`, "-f", ".devcontainer/guix/environments.scm"],
          { capture: true, env }
        );
        for (const [local, root] of group.roots.entries()) {
          const profile = required(plan.roots[root], "Missing Guix root");
          link(join(environments, "share/workbench/environments", String(local)), profile.profile);
          profiles[root] = {
            path: profile.path,
            profile: realpathSync(profile.profile),
            runtime: realpathSync(group.runtime)
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
  return {
    ...process.env,
    WORKBENCH_GUIX_PROFILES_FILE: file,
    WORKBENCH_GUIX_TIME_MACHINE_PROFILE: realpathSync(runtimeProfile)
  };
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
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
    runtime: join(output, `runtime-${String(index)}`),
    imageRoot: join(output, `environments-${String(index)}`)
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
    imageRoot: join(output, "image-root")
  });
  await withManagedProcesses(async (scope) => {
    await prepareGuixProfiles(plan, scope);
  });
}
export {
  prepareGuixProfiles
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZ3VpeC1wcm9maWxlcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIHN0cmluZ3MgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyB0eXBlIE1hbmFnZWRQcm9jZXNzU2NvcGUsIHdpdGhNYW5hZ2VkUHJvY2Vzc2VzIH0gZnJvbSBcIi4vbWFuYWdlZC1wcm9jZXNzLm1qc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCByZWFscGF0aFN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgc3ltbGlua1N5bmMsIHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZ3VpeENoYW5uZWxHcm91cHMsIHZhbGlkYXRlTWFuYWdlZFBsYW4gfSBmcm9tIFwiLi9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuXG5mdW5jdGlvbiBsaW5rKHRhcmdldDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpIHtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gYCR7cGF0aH0uJHtyYW5kb21VVUlEKCl9LnBhcnRpYWxgO1xuICB0cnkge1xuICAgIHN5bWxpbmtTeW5jKHJlYWxwYXRoU3luYyh0YXJnZXQpLCB0ZW1wb3JhcnkpO1xuICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcG9yYXJ5LCB7IGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbi8qKiBFdmFsdWF0ZSBlYWNoIGdyb3VwIHdpdGggaXRzIHBpbm5lZCBHdWl4OyBvbmx5IHJlYWxpemVkIHN0b3JlIHByb2ZpbGVzIGNyb3NzIGludG8gZmluYWwgaW1hZ2UgYXNzZW1ibHkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJlcGFyZUd1aXhQcm9maWxlcyh2YWx1ZTogdW5rbm93biwgc2NvcGU6IE1hbmFnZWRQcm9jZXNzU2NvcGUpIHtcbiAgY29uc3QgcGxhbiA9IHZhbGlkYXRlTWFuYWdlZFBsYW4odmFsdWUpO1xuICBpZiAocGxhbi5idWlsZGVyICE9PSBcImd1aXhcIikgdGhyb3cgbmV3IEVycm9yKFwiRXhwZWN0ZWQgR3VpeCBwcmVwYXJhdGlvbiBwbGFuXCIpO1xuICBjb25zdCBncm91cHMgPSByZXF1aXJlZChwbGFuLmd1aXgsIFwiTWlzc2luZyBHdWl4IGNoYW5uZWwgZ3JvdXBzXCIpO1xuICBjb25zdCBydW50aW1lUHJvZmlsZSA9IHJlcXVpcmVkKHBsYW4ucnVudGltZSwgXCJNaXNzaW5nIEd1aXggcnVudGltZVwiKTtcbiAgY29uc3QgcHJvZmlsZXMgPSBuZXcgQXJyYXk8eyBwYXRoOiBzdHJpbmc7IHByb2ZpbGU6IHN0cmluZzsgcnVudGltZTogc3RyaW5nIH0+KHBsYW4ucm9vdHMubGVuZ3RoKTtcbiAgY29uc3Qgb3B0aW9ucyA9IFtgLS1jb3Jlcz0ke1N0cmluZyhwbGFuLmNvcmVzKX1gLCBgLS1tYXgtam9icz0ke1N0cmluZyhwbGFuLm1heEpvYnMpfWBdO1xuICBjb25zdCBib290c3RyYXAgPSBqb2luKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiY2ktZ3VpeC1ib290c3RyYXAuc2NtXCIpO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3VwcylcbiAgICBzY29wZS5kZWZlcigoKSA9PiB7XG4gICAgICBybVN5bmMoZ3JvdXAuaW1hZ2VSb290LCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0pO1xuICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPCBncm91cHMubGVuZ3RoOyBvZmZzZXQgKz0gcGxhbi5tYXhKb2JzKSB7XG4gICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChcbiAgICAgIGdyb3Vwcy5zbGljZShvZmZzZXQsIG9mZnNldCArIHBsYW4ubWF4Sm9icykubWFwKGFzeW5jIChncm91cCwgcG9zaXRpb246IG51bWJlcikgPT4ge1xuICAgICAgICBjb25zdCBpbmRleCA9IG9mZnNldCArIHBvc2l0aW9uO1xuICAgICAgICBjb25zdCBydW50aW1lID0gYXdhaXQgc2NvcGUucnVuKFwiZ3VpeFwiLCBbXCJ0aW1lLW1hY2hpbmVcIiwgXCItQ1wiLCBncm91cC5jaGFubmVscywgLi4ub3B0aW9uc10sIHsgY2FwdHVyZTogdHJ1ZSB9KTtcbiAgICAgICAgbGluayhydW50aW1lLCBncm91cC5ydW50aW1lKTtcbiAgICAgICAgY29uc3QgZ3VpeCA9IGpvaW4oZ3JvdXAucnVudGltZSwgXCJiaW4vZ3VpeFwiKTtcbiAgICAgICAgYXdhaXQgc2NvcGUucnVuKGd1aXgsIFtcInJlcGxcIiwgYm9vdHN0cmFwLCBcInJlZ2lzdGVyLXJvb3RzXCIsIGdyb3VwLnJ1bnRpbWVdKTtcbiAgICAgICAgY29uc3Qgcm9vdHNGaWxlID0gam9pbihwbGFuLm91dHB1dCwgYGd1aXgtcm9vdHMtJHtTdHJpbmcoaW5kZXgpfS5qc29uYCk7XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgcm9vdHNGaWxlLFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGdyb3VwLnJvb3RzLm1hcCgocm9vdDogbnVtYmVyKSA9PiByZXF1aXJlZChwbGFuLnJvb3RzW3Jvb3RdLCBcIk1pc3NpbmcgR3VpeCByb290XCIpLnBhdGgpKSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgZW52ID0ge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFdPUktCRU5DSF9ST09UU19GSUxFOiByb290c0ZpbGUsXG4gICAgICAgICAgV09SS0JFTkNIX0dVSVhfUFJPRklMRVNfRklMRTogdW5kZWZpbmVkLFxuICAgICAgICAgIFdPUktCRU5DSF9HVUlYX1RJTUVfTUFDSElORV9QUk9GSUxFOiByZWFscGF0aFN5bmMoZ3JvdXAucnVudGltZSksXG4gICAgICAgIH07XG4gICAgICAgIHJtU3luYyhncm91cC5pbWFnZVJvb3QsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgIGNvbnN0IGVudmlyb25tZW50cyA9IGF3YWl0IHNjb3BlLnJ1bihcbiAgICAgICAgICBndWl4LFxuICAgICAgICAgIFtcImJ1aWxkXCIsIC4uLm9wdGlvbnMsIGAtLXJvb3Q9JHtncm91cC5pbWFnZVJvb3R9YCwgXCItZlwiLCBcIi5kZXZjb250YWluZXIvZ3VpeC9lbnZpcm9ubWVudHMuc2NtXCJdLFxuICAgICAgICAgIHsgY2FwdHVyZTogdHJ1ZSwgZW52IH0sXG4gICAgICAgICk7XG4gICAgICAgIGZvciAoY29uc3QgW2xvY2FsLCByb290XSBvZiBncm91cC5yb290cy5lbnRyaWVzKCkpIHtcbiAgICAgICAgICBjb25zdCBwcm9maWxlID0gcmVxdWlyZWQocGxhbi5yb290c1tyb290XSwgXCJNaXNzaW5nIEd1aXggcm9vdFwiKTtcbiAgICAgICAgICBsaW5rKGpvaW4oZW52aXJvbm1lbnRzLCBcInNoYXJlL3dvcmtiZW5jaC9lbnZpcm9ubWVudHNcIiwgU3RyaW5nKGxvY2FsKSksIHByb2ZpbGUucHJvZmlsZSk7XG4gICAgICAgICAgcHJvZmlsZXNbcm9vdF0gPSB7XG4gICAgICAgICAgICBwYXRoOiBwcm9maWxlLnBhdGgsXG4gICAgICAgICAgICBwcm9maWxlOiByZWFscGF0aFN5bmMocHJvZmlsZS5wcm9maWxlKSxcbiAgICAgICAgICAgIHJ1bnRpbWU6IHJlYWxwYXRoU3luYyhncm91cC5ydW50aW1lKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHNjb3BlLnJ1bihndWl4LCBbXG4gICAgICAgICAgXCJyZXBsXCIsXG4gICAgICAgICAgYm9vdHN0cmFwLFxuICAgICAgICAgIFwicmVnaXN0ZXItcm9vdHNcIixcbiAgICAgICAgICAuLi5ncm91cC5yb290cy5tYXAoKHJvb3Q6IG51bWJlcikgPT4gcmVxdWlyZWQocGxhbi5yb290c1tyb290XSwgXCJNaXNzaW5nIEd1aXggcm9vdFwiKS5wcm9maWxlKSxcbiAgICAgICAgXSk7XG4gICAgICAgIHJtU3luYyhncm91cC5pbWFnZVJvb3QsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9KSxcbiAgICApO1xuICAgIGNvbnN0IGZhaWx1cmVzID0gcmVzdWx0cy5maWx0ZXIoKHJlc3VsdCkgPT4gcmVzdWx0LnN0YXR1cyA9PT0gXCJyZWplY3RlZFwiKS5tYXAoKHJlc3VsdCk6IHVua25vd24gPT4gcmVzdWx0LnJlYXNvbik7XG4gICAgaWYgKGZhaWx1cmVzLmxlbmd0aCkgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGZhaWx1cmVzLCBmYWlsdXJlcy5tYXAoU3RyaW5nKS5qb2luKFwiOyBcIikpO1xuICB9XG4gIGNvbnN0IGZpbGUgPSBqb2luKHBsYW4ub3V0cHV0LCBcImd1aXgtcHJvZmlsZXMuanNvblwiKTtcbiAgd3JpdGVGaWxlU3luYyhmaWxlLCBKU09OLnN0cmluZ2lmeShwcm9maWxlcykpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbi5vdXRwdXQsIFwiZ3VpeC1ydW50aW1lXCIpLCByZWFscGF0aFN5bmMocnVudGltZVByb2ZpbGUpKTtcbiAgcmV0dXJuIHtcbiAgICAuLi5wcm9jZXNzLmVudixcbiAgICBXT1JLQkVOQ0hfR1VJWF9QUk9GSUxFU19GSUxFOiBmaWxlLFxuICAgIFdPUktCRU5DSF9HVUlYX1RJTUVfTUFDSElORV9QUk9GSUxFOiByZWFscGF0aFN5bmMocnVudGltZVByb2ZpbGUpLFxuICB9O1xufVxuXG4vLyBUaGUgZmFsbGJhY2sgYnVpbGRlciBoYXMgaXRzIG93biBwZXJzaXN0ZW50IHN0b3JlOyBpdHMgdGVtcG9yYXJ5IGxpbmtzIGJlbG9uZyB0byB0aGF0IGJ1aWxkZXIncyBvdXRwdXQgZGlyZWN0b3J5LlxuaWYgKHByb2Nlc3MuYXJndlsxXSAmJiByZXNvbHZlKHByb2Nlc3MuYXJndlsxXSkgPT09IGltcG9ydC5tZXRhLmZpbGVuYW1lKSB7XG4gIGNvbnN0IG91dHB1dCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX09VVFBVVCA/PyBcIi9vdXRwdXRcIjtcbiAgY29uc3QgcGF0aHMgPSBzdHJpbmdzKFxuICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJlcXVpcmVkKHByb2Nlc3MuZW52LldPUktCRU5DSF9ST09UU19GSUxFLCBcIk1pc3Npbmcgcm9vdHMgZmlsZVwiKSwgXCJ1dGY4XCIpKSxcbiAgICBcIkludmFsaWQgbWFuYWdlZCByb290c1wiLFxuICApO1xuICBjb25zdCByb290cyA9IHBhdGhzLm1hcCgocGF0aCwgaW5kZXgpID0+ICh7XG4gICAgcGF0aCxcbiAgICBwcm9maWxlOiBqb2luKG91dHB1dCwgXCJwcm9maWxlc1wiLCBTdHJpbmcoaW5kZXgpKSxcbiAgfSkpO1xuICBta2RpclN5bmMoam9pbihvdXRwdXQsIFwicHJvZmlsZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBndWl4ID0gZ3VpeENoYW5uZWxHcm91cHMocHJvY2Vzcy5jd2QoKSwgcm9vdHMpLm1hcCgoZ3JvdXAsIGluZGV4KSA9PiAoe1xuICAgIC4uLmdyb3VwLFxuICAgIHJ1bnRpbWU6IGpvaW4ob3V0cHV0LCBgcnVudGltZS0ke1N0cmluZyhpbmRleCl9YCksXG4gICAgaW1hZ2VSb290OiBqb2luKG91dHB1dCwgYGVudmlyb25tZW50cy0ke1N0cmluZyhpbmRleCl9YCksXG4gIH0pKTtcbiAgY29uc3QgcGxhbiA9IHZhbGlkYXRlTWFuYWdlZFBsYW4oe1xuICAgIGJ1aWxkZXI6IFwiZ3VpeFwiLFxuICAgIGNvcmVzOiBOdW1iZXIocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfQ09SRVMpLFxuICAgIG1heEpvYnM6IE51bWJlcihwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9KT0JTKSxcbiAgICBvdXRwdXQsXG4gICAgcnVudGltZU93bmVyOiBvdXRwdXQsXG4gICAgcm9vdHMsXG4gICAgZ3VpeCxcbiAgICBydW50aW1lOiBndWl4WzBdPy5ydW50aW1lLFxuICAgIGltYWdlUm9vdDogam9pbihvdXRwdXQsIFwiaW1hZ2Utcm9vdFwiKSxcbiAgfSk7XG4gIGF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICAgIGF3YWl0IHByZXBhcmVHdWl4UHJvZmlsZXMocGxhbiwgc2NvcGUpO1xuICB9KTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxlQUFlO0FBQ2xDLFNBQW1DLDRCQUE0QjtBQUMvRCxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGNBQWMsY0FBYyxZQUFZLFFBQVEsYUFBYSxlQUFlLGlCQUFpQjtBQUN0RyxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLG1CQUFtQiwyQkFBMkI7QUFFdkQsU0FBUyxLQUFLLFFBQWdCLE1BQWM7QUFDMUMsUUFBTSxZQUFZLEdBQUcsSUFBSSxJQUFJLFdBQVcsQ0FBQztBQUN6QyxNQUFJO0FBQ0YsZ0JBQVksYUFBYSxNQUFNLEdBQUcsU0FBUztBQUMzQyxlQUFXLFdBQVcsSUFBSTtBQUFBLEVBQzVCLFVBQUU7QUFDQSxXQUFPLFdBQVcsRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ25DO0FBQ0Y7QUFHQSxlQUFzQixvQkFBb0IsT0FBZ0IsT0FBNEI7QUFDcEYsUUFBTSxPQUFPLG9CQUFvQixLQUFLO0FBQ3RDLE1BQUksS0FBSyxZQUFZLE9BQVEsT0FBTSxJQUFJLE1BQU0sZ0NBQWdDO0FBQzdFLFFBQU0sU0FBUyxTQUFTLEtBQUssTUFBTSw2QkFBNkI7QUFDaEUsUUFBTSxpQkFBaUIsU0FBUyxLQUFLLFNBQVMsc0JBQXNCO0FBQ3BFLFFBQU0sV0FBVyxJQUFJLE1BQTBELEtBQUssTUFBTSxNQUFNO0FBQ2hHLFFBQU0sVUFBVSxDQUFDLFdBQVcsT0FBTyxLQUFLLEtBQUssQ0FBQyxJQUFJLGNBQWMsT0FBTyxLQUFLLE9BQU8sQ0FBQyxFQUFFO0FBQ3RGLFFBQU0sWUFBWSxLQUFLLFlBQVksU0FBUyx1QkFBdUI7QUFDbkUsYUFBVyxTQUFTO0FBQ2xCLFVBQU0sTUFBTSxN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
