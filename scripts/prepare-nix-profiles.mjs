// Generated from prepare-nix-profiles.mts; edit the TypeScript source.
import { required, strings } from "../app/src/core/runtime/values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { validateManagedPlan } from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { managedSystem } from "../app/src/core/execution/environments/managed/managed-system.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbml4LXByb2ZpbGVzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgc3RyaW5ncyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyB3aXRoTWFuYWdlZFByb2Nlc3NlcyB9IGZyb20gXCIuL21hbmFnZWQtcHJvY2Vzcy5tanNcIjtcbmltcG9ydCB7IHZhbGlkYXRlTWFuYWdlZFBsYW4gfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9lbnZpcm9ubWVudHMvbWFuYWdlZC9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgbWFuYWdlZFN5c3RlbSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2Vudmlyb25tZW50cy9tYW5hZ2VkL21hbmFnZWQtc3lzdGVtLm1qc1wiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCByZWFscGF0aFN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuY29uc3QgcHJvamVjdCA9IHJlYWxwYXRoU3luYyhwcm9jZXNzLmN3ZCgpKTtcbmNvbnN0IHJvb3RzID0gc3RyaW5ncyhcbiAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVxdWlyZWQocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1JPT1RTX0ZJTEUsIFwiTWlzc2luZyByb290cyBmaWxlXCIpLCBcInV0ZjhcIikpLFxuICBcIkludmFsaWQgbWFuYWdlZCByb290c1wiLFxuKTtcbmNvbnN0IG91dHB1dCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX09VVFBVVCA/PyBcIi9vdXRwdXRcIjtcbmNvbnN0IHBsYW4gPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9QTEFOXG4gID8gdmFsaWRhdGVNYW5hZ2VkUGxhbihKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9QTEFOLCBcInV0ZjhcIikpKVxuICA6IHVuZGVmaW5lZDtcbmlmIChcbiAgcGxhbiAmJlxuICAocGxhbi5idWlsZGVyICE9PSBcIm5peFwiIHx8XG4gICAgcGxhbi5vdXRwdXQgIT09IG91dHB1dCB8fFxuICAgIEpTT04uc3RyaW5naWZ5KHBsYW4ucm9vdHMubWFwKChyb290KSA9PiByb290LnBhdGgpKSAhPT0gSlNPTi5zdHJpbmdpZnkocm9vdHMpKVxuKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJOaXggcHJlcGFyYXRpb24gcGxhbiBkb2VzIG5vdCBtYXRjaCB0aGUgc2VsZWN0ZWQgcm9vdHNcIik7XG5jb25zdCBzeXN0ZW0gPSBwbGFuPy5zeXN0ZW0gPz8gbWFuYWdlZFN5c3RlbSgpO1xuY29uc3Qgb3B0aW9ucyA9IFtcbiAgXCItLWV4dHJhLWV4cGVyaW1lbnRhbC1mZWF0dXJlc1wiLFxuICBcIm5peC1jb21tYW5kIGZsYWtlc1wiLFxuICBcIi0tY29yZXNcIixcbiAgU3RyaW5nKHBsYW4/LmNvcmVzID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPUkVTKSxcbiAgXCItLW1heC1qb2JzXCIsXG4gIFN0cmluZyhwbGFuPy5tYXhKb2JzID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0pPQlMpLFxuICBcIi0tc3lzdGVtXCIsXG4gIHN5c3RlbSxcbl07XG5hd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgY29uc3QgcnVuID0gKGFyZ3M6IHN0cmluZ1tdLCBjYXB0dXJlID0gZmFsc2UpID0+IHNjb3BlLnJ1bihcIm5peFwiLCBbLi4ub3B0aW9ucywgLi4uYXJnc10sIHsgY2FwdHVyZSB9KTtcbiAgYXdhaXQgcnVuKFtcbiAgICBcImJ1aWxkXCIsXG4gICAgXCItLW5vLXVwZGF0ZS1sb2NrLWZpbGVcIixcbiAgICBcIi0tbm8tbGlua1wiLFxuICAgIC4uLnJvb3RzLm1hcCgocm9vdCkgPT4gYHBhdGg6JHtwcm9qZWN0fS8ke3Jvb3R9I2RldlNoZWxscy4ke3N5c3RlbX0uZGVmYXVsdGApLFxuICBdKTtcbiAgY29uc3QgcHJvZmlsZXMgPSBbXTtcbiAgLy8gQ2FwdHVyZSBzaGVsbCBleHBvcnRzIGFmdGVyIHRoZSBzaGFyZWQgZGVwZW5kZW5jeSBncmFwaCBoYXMgZmluaXNoZWQ7IG5vIHByb2plY3QgY29tbWFuZHMgcnVuIGhlcmUuXG4gIGZvciAoY29uc3QgW2luZGV4LCByb290XSBvZiByb290cy5lbnRyaWVzKCkpIHtcbiAgICBjb25zdCBwcm9maWxlID0gcGxhbj8ucm9vdHNbaW5kZXhdPy5wcm9maWxlID8/IGpvaW4ob3V0cHV0LCBcInByb2ZpbGVzXCIsIFN0cmluZyhpbmRleCkpO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImRldmVsb3BcIixcbiAgICAgIFwiLS1uby11cGRhdGUtbG9jay1maWxlXCIsXG4gICAgICBcIi0tcHJvZmlsZVwiLFxuICAgICAgcHJvZmlsZSxcbiAgICAgIGBwYXRoOiR7cHJvamVjdH0vJHtyb290fSNkZXZTaGVsbHMuJHtzeXN0ZW19LmRlZmF1bHRgLFxuICAgICAgXCItLWNvbW1hbmRcIixcbiAgICAgIFwidHJ1ZVwiLFxuICAgIF0pO1xuICAgIHByb2ZpbGVzLnB1c2gocmVhbHBhdGhTeW5jKHByb2ZpbGUpKTtcbiAgfVxuICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0LCBcInByb2ZpbGVzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHByb2ZpbGVzKSk7XG4gIGNvbnN0IGltYWdlID0gKFxuICAgIGF3YWl0IHJ1bihcbiAgICAgIFtcbiAgICAgICAgXCJidWlsZFwiLFxuICAgICAgICBcIi0taW1wdXJlXCIsXG4gICAgICAgIFwiLS1vdXQtbGlua1wiLFxuICAgICAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9JTUFHRV9ST09UID8/IGpvaW4ob3V0cHV0LCBcImltYWdlLXJvb3RcIiksXG4gICAgICAgIFwiLS1wcmludC1vdXQtcGF0aHNcIixcbiAgICAgICAgXCItLWV4cHJcIixcbiAgICAgICAgYGltcG9ydCAke3Byb2plY3R9Ly5kZXZjb250YWluZXIvbml4L2ltYWdlLm5peCB7IHN5c3RlbSA9ICR7SlNPTi5zdHJpbmdpZnkoc3lzdGVtKX07IHByb2plY3QgPSAke0pTT04uc3RyaW5naWZ5KHByb2plY3QpfTsgb3V0cHV0ID0gJHtKU09OLnN0cmluZ2lmeShvdXRwdXQpfTsgfWAsXG4gICAgICBdLFxuICAgICAgdHJ1ZSxcbiAgICApXG4gICkudHJpbSgpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0LCBcImltYWdlLXBhdGhcIiksIGAke2ltYWdlfVxcbmApO1xufSk7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsZUFBZTtBQUNsQyxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGNBQWMsY0FBYyxxQkFBcUI7QUFDMUQsU0FBUyxZQUFZO0FBRXJCLE1BQU0sVUFBVSxhQUFhLFFBQVEsSUFBSSxDQUFDO0FBQzFDLE1BQU0sUUFBUTtBQUFBLEVBQ1osS0FBSyxNQUFNLGFBQWEsU0FBUyxRQUFRLElBQUksc0JBQXNCLG9CQUFvQixHQUFHLE1BQU0sQ0FBQztBQUFBLEVBQ2pHO0FBQ0Y7QUFDQSxNQUFNLFNBQVMsUUFBUSxJQUFJLDRCQUE0QjtBQUN2RCxNQUFNLE9BQU8sUUFBUSxJQUFJLHlCQUNyQixvQkFBb0IsS0FBSyxNQUFNLGFBQWEsUUFBUSxJQUFJLHdCQUF3QixNQUFNLENBQUMsQ0FBQyxJQUN4RjtBQUNKLElBQ0UsU0FDQyxLQUFLLFlBQVksU0FDaEIsS0FBSyxXQUFXLFVBQ2hCLEtBQUssVUFBVSxLQUFLLE1BQU0sSUFBSSxDQUFDLFNBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxLQUFLLFVBQVUsS0FBSztBQUU5RSxRQUFNLElBQUksTUFBTSx3REFBd0Q7QUFDMUUsTUFBTSxTQUFTLE1BQU0sVUFBVSxjQUFjO0FBQzdDLE1BQU0sVUFBVTtBQUFBLEVBQ2Q7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0EsT0FBTyxNQUFNLFNBQVMsUUFBUSxJQUFJLHVCQUF1QjtBQUFBLEVBQ3pEO0FBQUEsRUFDQSxPQUFPLE1BQU0sV0FBVyxRQUFRLElBQUksc0JBQXNCO0FBQUEsRUFDMUQ7QUFBQSxFQUNBO0FBQ0Y7QUFDQSxNQUFNLHFCQUFxQixPQUFPLFVBQVU7QUFDMUMsUUFBTSxNQUFNLENBQUMsTUFBZ0IsVUFBVSxVQUFVLE1BQU0sSUFBSSxPQUFPLENBQUMsR0FBRyxTQUFTLEdBQUcsSUFBSSxHQUFHLEVBQUUsUUFBUSxDQUFDO0FBQ3BHLFFBQU0sSUFBSTtBQUFBLElBQ1I7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsR0FBRyxNQUFNLElBQUksQ0FBQyxTQUFTLFFBQVEsT0FBTyxJQUFJLElBQUksY0FBYyxNQUFNLFVBQVU7QUFBQSxFQUM5RSxDQUFDO0FBQ0QsUUFBTSxXQUFXLENBQUM7QUFFbEIsYUFBVyxDQUFDLE9BQU8sSUFBSSxLQUFLLE1BQU0sUUFBUSxHQUFHO0FBQzNDLFVBQU0sVUFBVSxNQUFNLE1BQU0sS0FBSyxHQUFHLFdBQVcsS0FBSyxRQUFRLFlBQVksT0FBTyxLQUFLLENBQUM7QUFDckYsVUFBTSxJQUFJO0FBQUEsTUFDUjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsUUFBUSxPQUFPLElBQUksSUFBSSxjQUFjLE1BQU07QUFBQSxNQUMzQztBQUFBLE1BQ0E7QUFBQSxJQUNGLENBQUM7QUFDRCxhQUFTLEtBQUssYUFBYSxPQUFPLENBQUM7QUFBQSxFQUNyQztBQUNBLGdCQUFjLEtBQUssUUFBUSxlQUFlLEdBQUcsS0FBSyxVQUFVLFFBQVEsQ0FBQztBQUNyRSxRQUFNLFNBQ0osTUFBTTtBQUFBLElBQ0o7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVEsSUFBSSxnQ0FBZ0MsS0FBSyxRQUFRLFlBQVk7QUFBQSxNQUNyRTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFVBQVUsT0FBTywyQ0FBMkMsS0FBSyxVQUFVLE1BQU0sQ0FBQyxlQUFlLEtBQUssVUFBVSxPQUFPLENBQUMsY0FBYyxLQUFLLFVBQVUsTUFBTSxDQUFDO0FBQUEsSUFDOUo7QUFBQSxJQUNBO0FBQUEsRUFDRixHQUNBLEtBQUs7QUFDUCxnQkFBYyxLQUFLLFFBQVEsWUFBWSxHQUFHLEdBQUcsS0FBSztBQUFBLENBQUk7QUFDeEQsQ0FBQzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3ByZXBhcmUtbml4LXByb2ZpbGVzLm1qcyJ9
