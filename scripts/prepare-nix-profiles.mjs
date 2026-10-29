// Generated from prepare-nix-profiles.mts; edit the TypeScript source.
import { required, strings } from "./values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { validateManagedPlan } from "./managed-contract.mjs";
import { managedSystem } from "./managed-system.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const project = realpathSync(process.cwd());
const roots = strings(
  JSON.parse(readFileSync(required(process.env.WORKBENCH_ROOTS_FILE, "Missing roots file"), "utf8")),
  "Invalid managed roots"
);
const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
const plan = process.env.WORKBENCH_MANAGED_PLAN ? validateManagedPlan(JSON.parse(readFileSync(process.env.WORKBENCH_MANAGED_PLAN, "utf8"))) : void 0;
if (plan && (plan.builder !== "nix" || plan.output !== output || JSON.stringify(plan.roots.map((root) => root.path)) !== JSON.stringify(roots)))
  throw new Error("Nix preparation plan does not match the selected roots");
const system = plan?.system ?? managedSystem();
const options = [
  "--extra-experimental-features",
  "nix-command flakes",
  "--cores",
  String(plan?.cores ?? process.env.WORKBENCH_MANAGED_CORES),
  "--max-jobs",
  String(plan?.maxJobs ?? process.env.WORKBENCH_MANAGED_JOBS),
  "--system",
  system
];
await withManagedProcesses(async (scope) => {
  const run = (args, capture = false) => scope.run("nix", [...options, ...args], { capture });
  await run([
    "build",
    "--no-update-lock-file",
    "--no-link",
    ...roots.map((root) => `path:${project}/${root}#devShells.${system}.default`)
  ]);
  const profiles = [];
  for (const [index, root] of roots.entries()) {
    const profile = plan?.roots[index]?.profile ?? join(output, "profiles", String(index));
    await run([
      "develop",
      "--no-update-lock-file",
      "--profile",
      profile,
      `path:${project}/${root}#devShells.${system}.default`,
      "--command",
      "true"
    ]);
    profiles.push(realpathSync(profile));
  }
  writeFileSync(join(output, "profiles.json"), JSON.stringify(profiles));
  const image = (await run(
    [
      "build",
      "--impure",
      "--out-link",
      process.env.WORKBENCH_MANAGED_IMAGE_ROOT ?? join(output, "image-root"),
      "--print-out-paths",
      "--expr",
      `import ${project}/.devcontainer/nix/image.nix { system = ${JSON.stringify(system)}; project = ${JSON.stringify(project)}; output = ${JSON.stringify(output)}; }`
    ],
    true
  )).trim();
  writeFileSync(join(output, "image-path"), `${image}
`);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbml4LXByb2ZpbGVzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgc3RyaW5ncyB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzIH0gZnJvbSBcIi4vbWFuYWdlZC1wcm9jZXNzLm1qc1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVNYW5hZ2VkUGxhbiB9IGZyb20gXCIuL21hbmFnZWQtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyBtYW5hZ2VkU3lzdGVtIH0gZnJvbSBcIi4vbWFuYWdlZC1zeXN0ZW0ubWpzXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHJlYWxwYXRoU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5jb25zdCBwcm9qZWN0ID0gcmVhbHBhdGhTeW5jKHByb2Nlc3MuY3dkKCkpO1xuY29uc3Qgcm9vdHMgPSBzdHJpbmdzKFxuICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXF1aXJlZChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUk9PVFNfRklMRSwgXCJNaXNzaW5nIHJvb3RzIGZpbGVcIiksIFwidXRmOFwiKSksXG4gIFwiSW52YWxpZCBtYW5hZ2VkIHJvb3RzXCIsXG4pO1xuY29uc3Qgb3V0cHV0ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfT1VUUFVUID8/IFwiL291dHB1dFwiO1xuY29uc3QgcGxhbiA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX1BMQU5cbiAgPyB2YWxpZGF0ZU1hbmFnZWRQbGFuKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX1BMQU4sIFwidXRmOFwiKSkpXG4gIDogdW5kZWZpbmVkO1xuaWYgKFxuICBwbGFuICYmXG4gIChwbGFuLmJ1aWxkZXIgIT09IFwibml4XCIgfHxcbiAgICBwbGFuLm91dHB1dCAhPT0gb3V0cHV0IHx8XG4gICAgSlNPTi5zdHJpbmdpZnkocGxhbi5yb290cy5tYXAoKHJvb3QpID0+IHJvb3QucGF0aCkpICE9PSBKU09OLnN0cmluZ2lmeShyb290cykpXG4pXG4gIHRocm93IG5ldyBFcnJvcihcIk5peCBwcmVwYXJhdGlvbiBwbGFuIGRvZXMgbm90IG1hdGNoIHRoZSBzZWxlY3RlZCByb290c1wiKTtcbmNvbnN0IHN5c3RlbSA9IHBsYW4/LnN5c3RlbSA/PyBtYW5hZ2VkU3lzdGVtKCk7XG5jb25zdCBvcHRpb25zID0gW1xuICBcIi0tZXh0cmEtZXhwZXJpbWVudGFsLWZlYXR1cmVzXCIsXG4gIFwibml4LWNvbW1hbmQgZmxha2VzXCIsXG4gIFwiLS1jb3Jlc1wiLFxuICBTdHJpbmcocGxhbj8uY29yZXMgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfQ09SRVMpLFxuICBcIi0tbWF4LWpvYnNcIixcbiAgU3RyaW5nKHBsYW4/Lm1heEpvYnMgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfSk9CUyksXG4gIFwiLS1zeXN0ZW1cIixcbiAgc3lzdGVtLFxuXTtcbmF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICBjb25zdCBydW4gPSAoYXJnczogc3RyaW5nW10sIGNhcHR1cmUgPSBmYWxzZSkgPT4gc2NvcGUucnVuKFwibml4XCIsIFsuLi5vcHRpb25zLCAuLi5hcmdzXSwgeyBjYXB0dXJlIH0pO1xuICBhd2FpdCBydW4oW1xuICAgIFwiYnVpbGRcIixcbiAgICBcIi0tbm8tdXBkYXRlLWxvY2stZmlsZVwiLFxuICAgIFwiLS1uby1saW5rXCIsXG4gICAgLi4ucm9vdHMubWFwKChyb290KSA9PiBgcGF0aDoke3Byb2plY3R9LyR7cm9vdH0jZGV2U2hlbGxzLiR7c3lzdGVtfS5kZWZhdWx0YCksXG4gIF0pO1xuICBjb25zdCBwcm9maWxlcyA9IFtdO1xuICAvLyBDYXB0dXJlIHNoZWxsIGV4cG9ydHMgYWZ0ZXIgdGhlIHNoYXJlZCBkZXBlbmRlbmN5IGdyYXBoIGhhcyBmaW5pc2hlZDsgbm8gcHJvamVjdCBjb21tYW5kcyBydW4gaGVyZS5cbiAgZm9yIChjb25zdCBbaW5kZXgsIHJvb3RdIG9mIHJvb3RzLmVudHJpZXMoKSkge1xuICAgIGNvbnN0IHByb2ZpbGUgPSBwbGFuPy5yb290c1tpbmRleF0/LnByb2ZpbGUgPz8gam9pbihvdXRwdXQsIFwicHJvZmlsZXNcIiwgU3RyaW5nKGluZGV4KSk7XG4gICAgYXdhaXQgcnVuKFtcbiAgICAgIFwiZGV2ZWxvcFwiLFxuICAgICAgXCItLW5vLXVwZGF0ZS1sb2NrLWZpbGVcIixcbiAgICAgIFwiLS1wcm9maWxlXCIsXG4gICAgICBwcm9maWxlLFxuICAgICAgYHBhdGg6JHtwcm9qZWN0fS8ke3Jvb3R9I2RldlNoZWxscy4ke3N5c3RlbX0uZGVmYXVsdGAsXG4gICAgICBcIi0tY29tbWFuZFwiLFxuICAgICAgXCJ0cnVlXCIsXG4gICAgXSk7XG4gICAgcHJvZmlsZXMucHVzaChyZWFscGF0aFN5bmMocHJvZmlsZSkpO1xuICB9XG4gIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXQsIFwicHJvZmlsZXMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocHJvZmlsZXMpKTtcbiAgY29uc3QgaW1hZ2UgPSAoXG4gICAgYXdhaXQgcnVuKFxuICAgICAgW1xuICAgICAgICBcImJ1aWxkXCIsXG4gICAgICAgIFwiLS1pbXB1cmVcIixcbiAgICAgICAgXCItLW91dC1saW5rXCIsXG4gICAgICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0lNQUdFX1JPT1QgPz8gam9pbihvdXRwdXQsIFwiaW1hZ2Utcm9vdFwiKSxcbiAgICAgICAgXCItLXByaW50LW91dC1wYXRoc1wiLFxuICAgICAgICBcIi0tZXhwclwiLFxuICAgICAgICBgaW1wb3J0ICR7cHJvamVjdH0vLmRldmNvbnRhaW5lci9uaXgvaW1hZ2Uubml4IHsgc3lzdGVtID0gJHtKU09OLnN0cmluZ2lmeShzeXN0ZW0pfTsgcHJvamVjdCA9ICR7SlNPTi5zdHJpbmdpZnkocHJvamVjdCl9OyBvdXRwdXQgPSAke0pTT04uc3RyaW5naWZ5KG91dHB1dCl9OyB9YCxcbiAgICAgIF0sXG4gICAgICB0cnVlLFxuICAgIClcbiAgKS50cmltKCk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXQsIFwiaW1hZ2UtcGF0aFwiKSwgYCR7aW1hZ2V9XFxuYCk7XG59KTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxlQUFlO0FBQ2xDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsY0FBYyxjQUFjLHFCQUFxQjtBQUMxRCxTQUFTLFlBQVk7QUFFckIsTUFBTSxVQUFVLGFBQWEsUUFBUSxJQUFJLENBQUM7QUFDMUMsTUFBTSxRQUFRO0FBQUEsRUFDWixLQUFLLE1BQU0sYUFBYSxTQUFTLFFBQVEsSUFBSSxzQkFBc0Isb0JBQW9CLEdBQUcsTUFBTSxDQUFDO0FBQUEsRUFDakc7QUFDRjtBQUNBLE1BQU0sU0FBUyxRQUFRLElBQUksNEJBQTRCO0FBQ3ZELE1BQU0sT0FBTyxRQUFRLElBQUkseUJBQ3JCLG9CQUFvQixLQUFLLE1BQU0sYUFBYSxRQUFRLElBQUksd0JBQXdCLE1BQU0sQ0FBQyxDQUFDLElBQ3hGO0FBQ0osSUFDRSxTQUNDLEtBQUssWUFBWSxTQUNoQixLQUFLLFdBQVcsVUFDaEIsS0FBSyxVQUFVLEtBQUssTUFBTSxJQUFJLENBQUMsU0FBUyxLQUFLLElBQUksQ0FBQyxNQUFNLEtBQUssVUFBVSxLQUFLO0FBRTlFLFFBQU0sSUFBSSxNQUFNLHdEQUF3RDtBQUMxRSxNQUFNLFNBQVMsTUFBTSxVQUFVLGNBQWM7QUFDN0MsTUFBTSxVQUFVO0FBQUEsRUFDZDtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQSxPQUFPLE1BQU0sU0FBUyxRQUFRLElBQUksdUJBQXVCO0FBQUEsRUFDekQ7QUFBQSxFQUNBLE9BQU8sTUFBTSxXQUFXLFFBQVEsSUFBSSxzQkFBc0I7QUFBQSxFQUMxRDtBQUFBLEVBQ0E7QUFDRjtBQUNBLE1BQU0scUJBQXFCLE9BQU8sVUFBVTtBQUMxQyxRQUFNLE1BQU0sQ0FBQyxNQUFnQixVQUFVLFVBQVUsTUFBTSxJQUFJLE9BQU8sQ0FBQyxHQUFHLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBRSxRQUFRLENBQUM7QUFDcEcsUUFBTSxJQUFJO0FBQUEsSUFDUjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxHQUFHLE1BQU0sSUFBSSxDQUFDLFNBQVMsUUFBUSxPQUFPLElBQUksSUFBSSxjQUFjLE1BQU0sVUFBVTtBQUFBLEVBQzlFLENBQUM7QUFDRCxRQUFNLFdBQVcsQ0FBQztBQUVsQixhQUFXLENBQUMsT0FBTyxJQUFJLEtBQUssTUFBTSxRQUFRLEdBQUc7QUFDM0MsVUFBTSxVQUFVLE1BQU0sTUFBTSxLQUFLLEdBQUcsV0FBVyxLQUFLLFFBQVEsWUFBWSxPQUFPLEtBQUssQ0FBQztBQUNyRixVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxRQUFRLE9BQU8sSUFBSSxJQUFJLGNBQWMsTUFBTTtBQUFBLE1BQzNDO0FBQUEsTUFDQTtBQUFBLElBQ0YsQ0FBQztBQUNELGFBQVMsS0FBSyxhQUFhLE9BQU8sQ0FBQztBQUFBLEVBQ3JDO0FBQ0EsZ0JBQWMsS0FBSyxRQUFRLGVBQWUsR0FBRyxLQUFLLFVBQVUsUUFBUSxDQUFDO0FBQ3JFLFFBQU0sU0FDSixNQUFNO0FBQUEsSUFDSjtBQUFBLE1BQ0U7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsUUFBUSxJQUFJLGdDQUFnQyxLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQ3JFO0FBQUEsTUFDQTtBQUFBLE1BQ0EsVUFBVSxPQUFPLDJDQUEyQyxLQUFLLFVBQVUsTUFBTSxDQUFDLGVBQWUsS0FBSyxVQUFVLE9BQU8sQ0FBQyxjQUFjLEtBQUssVUFBVSxNQUFNLENBQUM7QUFBQSxJQUM5SjtBQUFBLElBQ0E7QUFBQSxFQUNGLEdBQ0EsS0FBSztBQUNQLGdCQUFjLEtBQUssUUFBUSxZQUFZLEdBQUcsR0FBRyxLQUFLO0FBQUEsQ0FBSTtBQUN4RCxDQUFDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcHJlcGFyZS1uaXgtcHJvZmlsZXMubWpzIn0=
