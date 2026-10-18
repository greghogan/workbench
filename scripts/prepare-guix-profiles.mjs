// Generated from prepare-guix-profiles.mts; edit the TypeScript source.
import { required, strings } from "./values.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { guixChannelGroups, validateManagedPlan } from "./managed-contract.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZ3VpeC1wcm9maWxlcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIHN0cmluZ3MgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgdHlwZSB7IE1hbmFnZWRQcm9jZXNzU2NvcGUgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHJlYWxwYXRoU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCBzeW1saW5rU3luYywgd3JpdGVGaWxlU3luYywgbWtkaXJTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBndWl4Q2hhbm5lbEdyb3VwcywgdmFsaWRhdGVNYW5hZ2VkUGxhbiB9IGZyb20gXCIuL21hbmFnZWQtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyB3aXRoTWFuYWdlZFByb2Nlc3NlcyB9IGZyb20gXCIuL21hbmFnZWQtcHJvY2Vzcy5tanNcIjtcblxuZnVuY3Rpb24gbGluayh0YXJnZXQ6IHN0cmluZywgcGF0aDogc3RyaW5nKSB7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IGAke3BhdGh9LiR7cmFuZG9tVVVJRCgpfS5wYXJ0aWFsYDtcbiAgdHJ5IHtcbiAgICBzeW1saW5rU3luYyhyZWFscGF0aFN5bmModGFyZ2V0KSwgdGVtcG9yYXJ5KTtcbiAgICByZW5hbWVTeW5jKHRlbXBvcmFyeSwgcGF0aCk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRlbXBvcmFyeSwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG4vKiogRXZhbHVhdGUgZWFjaCBncm91cCB3aXRoIGl0cyBwaW5uZWQgR3VpeDsgb25seSByZWFsaXplZCBzdG9yZSBwcm9maWxlcyBjcm9zcyBpbnRvIGZpbmFsIGltYWdlIGFzc2VtYmx5LiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHByZXBhcmVHdWl4UHJvZmlsZXModmFsdWU6IHVua25vd24sIHNjb3BlOiBNYW5hZ2VkUHJvY2Vzc1Njb3BlKSB7XG4gIGNvbnN0IHBsYW4gPSB2YWxpZGF0ZU1hbmFnZWRQbGFuKHZhbHVlKTtcbiAgaWYgKHBsYW4uYnVpbGRlciAhPT0gXCJndWl4XCIpIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIEd1aXggcHJlcGFyYXRpb24gcGxhblwiKTtcbiAgY29uc3QgZ3JvdXBzID0gcmVxdWlyZWQocGxhbi5ndWl4LCBcIk1pc3NpbmcgR3VpeCBjaGFubmVsIGdyb3Vwc1wiKTtcbiAgY29uc3QgcnVudGltZVByb2ZpbGUgPSByZXF1aXJlZChwbGFuLnJ1bnRpbWUsIFwiTWlzc2luZyBHdWl4IHJ1bnRpbWVcIik7XG4gIGNvbnN0IHByb2ZpbGVzID0gbmV3IEFycmF5PHsgcGF0aDogc3RyaW5nOyBwcm9maWxlOiBzdHJpbmc7IHJ1bnRpbWU6IHN0cmluZyB9PihwbGFuLnJvb3RzLmxlbmd0aCk7XG4gIGNvbnN0IG9wdGlvbnMgPSBbYC0tY29yZXM9JHtTdHJpbmcocGxhbi5jb3Jlcyl9YCwgYC0tbWF4LWpvYnM9JHtTdHJpbmcocGxhbi5tYXhKb2JzKX1gXTtcbiAgY29uc3QgYm9vdHN0cmFwID0gam9pbihpbXBvcnQubWV0YS5kaXJuYW1lLCBcImNpLWd1aXgtYm9vdHN0cmFwLnNjbVwiKTtcbiAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMpXG4gICAgc2NvcGUuZGVmZXIoKCkgPT4ge1xuICAgICAgcm1TeW5jKGdyb3VwLmltYWdlUm9vdCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9KTtcbiAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDwgZ3JvdXBzLmxlbmd0aDsgb2Zmc2V0ICs9IHBsYW4ubWF4Sm9icykge1xuICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoXG4gICAgICBncm91cHMuc2xpY2Uob2Zmc2V0LCBvZmZzZXQgKyBwbGFuLm1heEpvYnMpLm1hcChhc3luYyAoZ3JvdXAsIHBvc2l0aW9uOiBudW1iZXIpID0+IHtcbiAgICAgICAgY29uc3QgaW5kZXggPSBvZmZzZXQgKyBwb3NpdGlvbjtcbiAgICAgICAgY29uc3QgcnVudGltZSA9IGF3YWl0IHNjb3BlLnJ1bihcImd1aXhcIiwgW1widGltZS1tYWNoaW5lXCIsIFwiLUNcIiwgZ3JvdXAuY2hhbm5lbHMsIC4uLm9wdGlvbnNdLCB7IGNhcHR1cmU6IHRydWUgfSk7XG4gICAgICAgIGxpbmsocnVudGltZSwgZ3JvdXAucnVudGltZSk7XG4gICAgICAgIGNvbnN0IGd1aXggPSBqb2luKGdyb3VwLnJ1bnRpbWUsIFwiYmluL2d1aXhcIik7XG4gICAgICAgIGF3YWl0IHNjb3BlLnJ1bihndWl4LCBbXCJyZXBsXCIsIGJvb3RzdHJhcCwgXCJyZWdpc3Rlci1yb290c1wiLCBncm91cC5ydW50aW1lXSk7XG4gICAgICAgIGNvbnN0IHJvb3RzRmlsZSA9IGpvaW4ocGxhbi5vdXRwdXQsIGBndWl4LXJvb3RzLSR7U3RyaW5nKGluZGV4KX0uanNvbmApO1xuICAgICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICAgIHJvb3RzRmlsZSxcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShncm91cC5yb290cy5tYXAoKHJvb3Q6IG51bWJlcikgPT4gcmVxdWlyZWQocGxhbi5yb290c1tyb290XSwgXCJNaXNzaW5nIEd1aXggcm9vdFwiKS5wYXRoKSksXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGVudiA9IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBXT1JLQkVOQ0hfUk9PVFNfRklMRTogcm9vdHNGaWxlLFxuICAgICAgICAgIFdPUktCRU5DSF9HVUlYX1BST0ZJTEVTX0ZJTEU6IHVuZGVmaW5lZCxcbiAgICAgICAgICBXT1JLQkVOQ0hfR1VJWF9USU1FX01BQ0hJTkVfUFJPRklMRTogcmVhbHBhdGhTeW5jKGdyb3VwLnJ1bnRpbWUpLFxuICAgICAgICB9O1xuICAgICAgICBybVN5bmMoZ3JvdXAuaW1hZ2VSb290LCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICBjb25zdCBlbnZpcm9ubWVudHMgPSBhd2FpdCBzY29wZS5ydW4oXG4gICAgICAgICAgZ3VpeCxcbiAgICAgICAgICBbXCJidWlsZFwiLCAuLi5vcHRpb25zLCBgLS1yb290PSR7Z3JvdXAuaW1hZ2VSb290fWAsIFwiLWZcIiwgXCIuZGV2Y29udGFpbmVyL2d1aXgvZW52aXJvbm1lbnRzLnNjbVwiXSxcbiAgICAgICAgICB7IGNhcHR1cmU6IHRydWUsIGVudiB9LFxuICAgICAgICApO1xuICAgICAgICBmb3IgKGNvbnN0IFtsb2NhbCwgcm9vdF0gb2YgZ3JvdXAucm9vdHMuZW50cmllcygpKSB7XG4gICAgICAgICAgY29uc3QgcHJvZmlsZSA9IHJlcXVpcmVkKHBsYW4ucm9vdHNbcm9vdF0sIFwiTWlzc2luZyBHdWl4IHJvb3RcIik7XG4gICAgICAgICAgbGluayhqb2luKGVudmlyb25tZW50cywgXCJzaGFyZS93b3JrYmVuY2gvZW52aXJvbm1lbnRzXCIsIFN0cmluZyhsb2NhbCkpLCBwcm9maWxlLnByb2ZpbGUpO1xuICAgICAgICAgIHByb2ZpbGVzW3Jvb3RdID0ge1xuICAgICAgICAgICAgcGF0aDogcHJvZmlsZS5wYXRoLFxuICAgICAgICAgICAgcHJvZmlsZTogcmVhbHBhdGhTeW5jKHByb2ZpbGUucHJvZmlsZSksXG4gICAgICAgICAgICBydW50aW1lOiByZWFscGF0aFN5bmMoZ3JvdXAucnVudGltZSksXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBzY29wZS5ydW4oZ3VpeCwgW1xuICAgICAgICAgIFwicmVwbFwiLFxuICAgICAgICAgIGJvb3RzdHJhcCxcbiAgICAgICAgICBcInJlZ2lzdGVyLXJvb3RzXCIsXG4gICAgICAgICAgLi4uZ3JvdXAucm9vdHMubWFwKChyb290OiBudW1iZXIpID0+IHJlcXVpcmVkKHBsYW4ucm9vdHNbcm9vdF0sIFwiTWlzc2luZyBHdWl4IHJvb3RcIikucHJvZmlsZSksXG4gICAgICAgIF0pO1xuICAgICAgICBybVN5bmMoZ3JvdXAuaW1hZ2VSb290LCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgICAgfSksXG4gICAgKTtcbiAgICBjb25zdCBmYWlsdXJlcyA9IHJlc3VsdHMuZmlsdGVyKChyZXN1bHQpID0+IHJlc3VsdC5zdGF0dXMgPT09IFwicmVqZWN0ZWRcIikubWFwKChyZXN1bHQpOiB1bmtub3duID0+IHJlc3VsdC5yZWFzb24pO1xuICAgIGlmIChmYWlsdXJlcy5sZW5ndGgpIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihmYWlsdXJlcywgZmFpbHVyZXMubWFwKFN0cmluZykuam9pbihcIjsgXCIpKTtcbiAgfVxuICBjb25zdCBmaWxlID0gam9pbihwbGFuLm91dHB1dCwgXCJndWl4LXByb2ZpbGVzLmpzb25cIik7XG4gIHdyaXRlRmlsZVN5bmMoZmlsZSwgSlNPTi5zdHJpbmdpZnkocHJvZmlsZXMpKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW4ub3V0cHV0LCBcImd1aXgtcnVudGltZVwiKSwgcmVhbHBhdGhTeW5jKHJ1bnRpbWVQcm9maWxlKSk7XG4gIHJldHVybiB7XG4gICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgV09SS0JFTkNIX0dVSVhfUFJPRklMRVNfRklMRTogZmlsZSxcbiAgICBXT1JLQkVOQ0hfR1VJWF9USU1FX01BQ0hJTkVfUFJPRklMRTogcmVhbHBhdGhTeW5jKHJ1bnRpbWVQcm9maWxlKSxcbiAgfTtcbn1cblxuLy8gVGhlIGZhbGxiYWNrIGJ1aWxkZXIgaGFzIGl0cyBvd24gcGVyc2lzdGVudCBzdG9yZTsgaXRzIHRlbXBvcmFyeSBsaW5rcyBiZWxvbmcgdG8gdGhhdCBidWlsZGVyJ3Mgb3V0cHV0IGRpcmVjdG9yeS5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgcmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pID09PSBpbXBvcnQubWV0YS5maWxlbmFtZSkge1xuICBjb25zdCBvdXRwdXQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9PVVRQVVQgPz8gXCIvb3V0cHV0XCI7XG4gIGNvbnN0IHBhdGhzID0gc3RyaW5ncyhcbiAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXF1aXJlZChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUk9PVFNfRklMRSwgXCJNaXNzaW5nIHJvb3RzIGZpbGVcIiksIFwidXRmOFwiKSksXG4gICAgXCJJbnZhbGlkIG1hbmFnZWQgcm9vdHNcIixcbiAgKTtcbiAgY29uc3Qgcm9vdHMgPSBwYXRocy5tYXAoKHBhdGgsIGluZGV4KSA9PiAoe1xuICAgIHBhdGgsXG4gICAgcHJvZmlsZTogam9pbihvdXRwdXQsIFwicHJvZmlsZXNcIiwgU3RyaW5nKGluZGV4KSksXG4gIH0pKTtcbiAgbWtkaXJTeW5jKGpvaW4ob3V0cHV0LCBcInByb2ZpbGVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgZ3VpeCA9IGd1aXhDaGFubmVsR3JvdXBzKHByb2Nlc3MuY3dkKCksIHJvb3RzKS5tYXAoKGdyb3VwLCBpbmRleCkgPT4gKHtcbiAgICAuLi5ncm91cCxcbiAgICBydW50aW1lOiBqb2luKG91dHB1dCwgYHJ1bnRpbWUtJHtTdHJpbmcoaW5kZXgpfWApLFxuICAgIGltYWdlUm9vdDogam9pbihvdXRwdXQsIGBlbnZpcm9ubWVudHMtJHtTdHJpbmcoaW5kZXgpfWApLFxuICB9KSk7XG4gIGNvbnN0IHBsYW4gPSB2YWxpZGF0ZU1hbmFnZWRQbGFuKHtcbiAgICBidWlsZGVyOiBcImd1aXhcIixcbiAgICBjb3JlczogTnVtYmVyKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPUkVTKSxcbiAgICBtYXhKb2JzOiBOdW1iZXIocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfSk9CUyksXG4gICAgb3V0cHV0LFxuICAgIHJ1bnRpbWVPd25lcjogb3V0cHV0LFxuICAgIHJvb3RzLFxuICAgIGd1aXgsXG4gICAgcnVudGltZTogZ3VpeFswXT8ucnVudGltZSxcbiAgICBpbWFnZVJvb3Q6IGpvaW4ob3V0cHV0LCBcImltYWdlLXJvb3RcIiksXG4gIH0pO1xuICBhd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgICBhd2FpdCBwcmVwYXJlR3VpeFByb2ZpbGVzKHBsYW4sIHNjb3BlKTtcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsZUFBZTtBQUVsQyxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGNBQWMsY0FBYyxZQUFZLFFBQVEsYUFBYSxlQUFlLGlCQUFpQjtBQUN0RyxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLG1CQUFtQiwyQkFBMkI7QUFDdkQsU0FBUyw0QkFBNEI7QUFFckMsU0FBUyxLQUFLLFFBQWdCLE1BQWM7QUFDMUMsUUFBTSxZQUFZLEdBQUcsSUFBSSxJQUFJLFdBQVcsQ0FBQztBQUN6QyxNQUFJO0FBQ0YsZ0JBQVksYUFBYSxNQUFNLEdBQUcsU0FBUztBQUMzQyxlQUFXLFdBQVcsSUFBSTtBQUFBLEVBQzVCLFVBQUU7QUFDQSxXQUFPLFdBQVcsRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ25DO0FBQ0Y7QUFHQSxlQUFzQixvQkFBb0IsT0FBZ0IsT0FBNEI7QUFDcEYsUUFBTSxPQUFPLG9CQUFvQixLQUFLO0FBQ3RDLE1BQUksS0FBSyxZQUFZLE9BQVEsT0FBTSxJQUFJLE1BQU0sZ0NBQWdDO0FBQzdFLFFBQU0sU0FBUyxTQUFTLEtBQUssTUFBTSw2QkFBNkI7QUFDaEUsUUFBTSxpQkFBaUIsU0FBUyxLQUFLLFNBQVMsc0JBQXNCO0FBQ3BFLFFBQU0sV0FBVyxJQUFJLE1BQTBELEtBQUssTUFBTSxNQUFNO0FBQ2hHLFFBQU0sVUFBVSxDQUFDLFdBQVcsT0FBTyxLQUFLLEtBQUssQ0FBQyxJQUFJLGNBQWMsT0FBTyxLQUFLLE9BQU8sQ0FBQyxFQUFFO0FBQ3RGLFFBQU0sWUFBWSxLQUFLLFlBQVksU0FB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
