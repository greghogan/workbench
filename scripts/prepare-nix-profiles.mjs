// Generated from prepare-nix-profiles.mts; edit the TypeScript source.
import { required, strings } from "./values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { validateManagedPlan } from "./managed-contract.mjs";
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
const system = process.arch === "x64" ? "x86_64-linux" : "aarch64-linux";
const options = [
  "--extra-experimental-features",
  "nix-command flakes",
  "--cores",
  String(plan?.cores ?? process.env.WORKBENCH_MANAGED_CORES),
  "--max-jobs",
  String(plan?.maxJobs ?? process.env.WORKBENCH_MANAGED_JOBS)
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
      `path:${project}/${root}`,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbml4LXByb2ZpbGVzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgc3RyaW5ncyB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzIH0gZnJvbSBcIi4vbWFuYWdlZC1wcm9jZXNzLm1qc1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVNYW5hZ2VkUGxhbiB9IGZyb20gXCIuL21hbmFnZWQtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHJlYWxwYXRoU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5jb25zdCBwcm9qZWN0ID0gcmVhbHBhdGhTeW5jKHByb2Nlc3MuY3dkKCkpO1xuY29uc3Qgcm9vdHMgPSBzdHJpbmdzKFxuICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXF1aXJlZChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUk9PVFNfRklMRSwgXCJNaXNzaW5nIHJvb3RzIGZpbGVcIiksIFwidXRmOFwiKSksXG4gIFwiSW52YWxpZCBtYW5hZ2VkIHJvb3RzXCIsXG4pO1xuY29uc3Qgb3V0cHV0ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfT1VUUFVUID8/IFwiL291dHB1dFwiO1xuY29uc3QgcGxhbiA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX1BMQU5cbiAgPyB2YWxpZGF0ZU1hbmFnZWRQbGFuKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX1BMQU4sIFwidXRmOFwiKSkpXG4gIDogdW5kZWZpbmVkO1xuaWYgKFxuICBwbGFuICYmXG4gIChwbGFuLmJ1aWxkZXIgIT09IFwibml4XCIgfHxcbiAgICBwbGFuLm91dHB1dCAhPT0gb3V0cHV0IHx8XG4gICAgSlNPTi5zdHJpbmdpZnkocGxhbi5yb290cy5tYXAoKHJvb3QpID0+IHJvb3QucGF0aCkpICE9PSBKU09OLnN0cmluZ2lmeShyb290cykpXG4pXG4gIHRocm93IG5ldyBFcnJvcihcIk5peCBwcmVwYXJhdGlvbiBwbGFuIGRvZXMgbm90IG1hdGNoIHRoZSBzZWxlY3RlZCByb290c1wiKTtcbmNvbnN0IHN5c3RlbSA9IHByb2Nlc3MuYXJjaCA9PT0gXCJ4NjRcIiA/IFwieDg2XzY0LWxpbnV4XCIgOiBcImFhcmNoNjQtbGludXhcIjtcbmNvbnN0IG9wdGlvbnMgPSBbXG4gIFwiLS1leHRyYS1leHBlcmltZW50YWwtZmVhdHVyZXNcIixcbiAgXCJuaXgtY29tbWFuZCBmbGFrZXNcIixcbiAgXCItLWNvcmVzXCIsXG4gIFN0cmluZyhwbGFuPy5jb3JlcyA/PyBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9DT1JFUyksXG4gIFwiLS1tYXgtam9ic1wiLFxuICBTdHJpbmcocGxhbj8ubWF4Sm9icyA/PyBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9KT0JTKSxcbl07XG5hd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgY29uc3QgcnVuID0gKGFyZ3M6IHN0cmluZ1tdLCBjYXB0dXJlID0gZmFsc2UpID0+IHNjb3BlLnJ1bihcIm5peFwiLCBbLi4ub3B0aW9ucywgLi4uYXJnc10sIHsgY2FwdHVyZSB9KTtcbiAgYXdhaXQgcnVuKFtcbiAgICBcImJ1aWxkXCIsXG4gICAgXCItLW5vLXVwZGF0ZS1sb2NrLWZpbGVcIixcbiAgICBcIi0tbm8tbGlua1wiLFxuICAgIC4uLnJvb3RzLm1hcCgocm9vdCkgPT4gYHBhdGg6JHtwcm9qZWN0fS8ke3Jvb3R9I2RldlNoZWxscy4ke3N5c3RlbX0uZGVmYXVsdGApLFxuICBdKTtcbiAgY29uc3QgcHJvZmlsZXMgPSBbXTtcbiAgLy8gQ2FwdHVyZSBzaGVsbCBleHBvcnRzIGFmdGVyIHRoZSBzaGFyZWQgZGVwZW5kZW5jeSBncmFwaCBoYXMgZmluaXNoZWQ7IG5vIHByb2plY3QgY29tbWFuZHMgcnVuIGhlcmUuXG4gIGZvciAoY29uc3QgW2luZGV4LCByb290XSBvZiByb290cy5lbnRyaWVzKCkpIHtcbiAgICBjb25zdCBwcm9maWxlID0gcGxhbj8ucm9vdHNbaW5kZXhdPy5wcm9maWxlID8/IGpvaW4ob3V0cHV0LCBcInByb2ZpbGVzXCIsIFN0cmluZyhpbmRleCkpO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImRldmVsb3BcIixcbiAgICAgIFwiLS1uby11cGRhdGUtbG9jay1maWxlXCIsXG4gICAgICBcIi0tcHJvZmlsZVwiLFxuICAgICAgcHJvZmlsZSxcbiAgICAgIGBwYXRoOiR7cHJvamVjdH0vJHtyb290fWAsXG4gICAgICBcIi0tY29tbWFuZFwiLFxuICAgICAgXCJ0cnVlXCIsXG4gICAgXSk7XG4gICAgcHJvZmlsZXMucHVzaChyZWFscGF0aFN5bmMocHJvZmlsZSkpO1xuICB9XG4gIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXQsIFwicHJvZmlsZXMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocHJvZmlsZXMpKTtcbiAgY29uc3QgaW1hZ2UgPSAoXG4gICAgYXdhaXQgcnVuKFxuICAgICAgW1xuICAgICAgICBcImJ1aWxkXCIsXG4gICAgICAgIFwiLS1pbXB1cmVcIixcbiAgICAgICAgXCItLW91dC1saW5rXCIsXG4gICAgICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0lNQUdFX1JPT1QgPz8gam9pbihvdXRwdXQsIFwiaW1hZ2Utcm9vdFwiKSxcbiAgICAgICAgXCItLXByaW50LW91dC1wYXRoc1wiLFxuICAgICAgICBcIi0tZXhwclwiLFxuICAgICAgICBgaW1wb3J0ICR7cHJvamVjdH0vLmRldmNvbnRhaW5lci9uaXgvaW1hZ2Uubml4IHsgc3lzdGVtID0gJHtKU09OLnN0cmluZ2lmeShzeXN0ZW0pfTsgcHJvamVjdCA9ICR7SlNPTi5zdHJpbmdpZnkocHJvamVjdCl9OyBvdXRwdXQgPSAke0pTT04uc3RyaW5naWZ5KG91dHB1dCl9OyB9YCxcbiAgICAgIF0sXG4gICAgICB0cnVlLFxuICAgIClcbiAgKS50cmltKCk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXQsIFwiaW1hZ2UtcGF0aFwiKSwgYCR7aW1hZ2V9XFxuYCk7XG59KTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxlQUFlO0FBQ2xDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsY0FBYyxjQUFjLHFCQUFxQjtBQUMxRCxTQUFTLFlBQVk7QUFFckIsTUFBTSxVQUFVLGFBQWEsUUFBUSxJQUFJLENBQUM7QUFDMUMsTUFBTSxRQUFRO0FBQUEsRUFDWixLQUFLLE1BQU0sYUFBYSxTQUFTLFFBQVEsSUFBSSxzQkFBc0Isb0JBQW9CLEdBQUcsTUFBTSxDQUFDO0FBQUEsRUFDakc7QUFDRjtBQUNBLE1BQU0sU0FBUyxRQUFRLElBQUksNEJBQTRCO0FBQ3ZELE1BQU0sT0FBTyxRQUFRLElBQUkseUJBQ3JCLG9CQUFvQixLQUFLLE1BQU0sYUFBYSxRQUFRLElBQUksd0JBQXdCLE1BQU0sQ0FBQyxDQUFDLElBQ3hGO0FBQ0osSUFDRSxTQUNDLEtBQUssWUFBWSxTQUNoQixLQUFLLFdBQVcsVUFDaEIsS0FBSyxVQUFVLEtBQUssTUFBTSxJQUFJLENBQUMsU0FBUyxLQUFLLElBQUksQ0FBQyxNQUFNLEtBQUssVUFBVSxLQUFLO0FBRTlFLFFBQU0sSUFBSSxNQUFNLHdEQUF3RDtBQUMxRSxNQUFNLFNBQVMsUUFBUSxTQUFTLFFBQVEsaUJBQWlCO0FBQ3pELE1BQU0sVUFBVTtBQUFBLEVBQ2Q7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0EsT0FBTyxNQUFNLFNBQVMsUUFBUSxJQUFJLHVCQUF1QjtBQUFBLEVBQ3pEO0FBQUEsRUFDQSxPQUFPLE1BQU0sV0FBVyxRQUFRLElBQUksc0JBQXNCO0FBQzVEO0FBQ0EsTUFBTSxxQkFBcUIsT0FBTyxVQUFVO0FBQzFDLFFBQU0sTUFBTSxDQUFDLE1BQWdCLFVBQVUsVUFBVSxNQUFNLElBQUksT0FBTyxDQUFDLEdBQUcsU0FBUyxHQUFHLElBQUksR0FBRyxFQUFFLFFBQVEsQ0FBQztBQUNwRyxRQUFNLElBQUk7QUFBQSxJQUNSO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLEdBQUcsTUFBTSxJQUFJLENBQUMsU0FBUyxRQUFRLE9BQU8sSUFBSSxJQUFJLGNBQWMsTUFBTSxVQUFVO0FBQUEsRUFDOUUsQ0FBQztBQUNELFFBQU0sV0FBVyxDQUFDO0FBRWxCLGFBQVcsQ0FBQyxPQUFPLElBQUksS0FBSyxNQUFNLFFBQVEsR0FBRztBQUMzQyxVQUFNLFVBQVUsTUFBTSxNQUFNLEtBQUssR0FBRyxXQUFXLEtBQUssUUFBUSxZQUFZLE9BQU8sS0FBSyxDQUFDO0FBQ3JGLFVBQU0sSUFBSTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVEsT0FBTyxJQUFJLElBQUk7QUFBQSxNQUN2QjtBQUFBLE1BQ0E7QUFBQSxJQUNGLENBQUM7QUFDRCxhQUFTLEtBQUssYUFBYSxPQUFPLENBQUM7QUFBQSxFQUNyQztBQUNBLGdCQUFjLEtBQUssUUFBUSxlQUFlLEdBQUcsS0FBSyxVQUFVLFFBQVEsQ0FBQztBQUNyRSxRQUFNLFNBQ0osTUFBTTtBQUFBLElBQ0o7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVEsSUFBSSxnQ0FBZ0MsS0FBSyxRQUFRLFlBQVk7QUFBQSxNQUNyRTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFVBQVUsT0FBTywyQ0FBMkMsS0FBSyxVQUFVLE1BQU0sQ0FBQyxlQUFlLEtBQUssVUFBVSxPQUFPLENBQUMsY0FBYyxLQUFLLFVBQVUsTUFBTSxDQUFDO0FBQUEsSUFDOUo7QUFBQSxJQUNBO0FBQUEsRUFDRixHQUNBLEtBQUs7QUFDUCxnQkFBYyxLQUFLLFFBQVEsWUFBWSxHQUFHLEdBQUcsS0FBSztBQUFBLENBQUk7QUFDeEQsQ0FBQzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3ByZXBhcmUtbml4LXByb2ZpbGVzLm1qcyJ9
