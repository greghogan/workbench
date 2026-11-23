import { required, strings } from "../app/src/core/runtime/values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { validateManagedPlan } from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { managedSystem } from "../app/src/core/execution/environments/managed/managed-system.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportManagedProfiles } from "../app/src/core/execution/environments/managed/profile-transfer.mjs";

const project = realpathSync(process.cwd());
const roots = strings(
  JSON.parse(readFileSync(required(process.env.WORKBENCH_ROOTS_FILE, "Missing roots file"), "utf8")),
  "Invalid managed roots",
);
const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
const plan = process.env.WORKBENCH_MANAGED_PLAN
  ? validateManagedPlan(JSON.parse(readFileSync(process.env.WORKBENCH_MANAGED_PLAN, "utf8")))
  : undefined;
if (
  plan &&
  (plan.builder !== "nix" ||
    plan.output !== output ||
    JSON.stringify(plan.roots.map((root) => root.path)) !== JSON.stringify(roots))
)
  throw new Error("Nix preparation plan does not match the selected roots");
const system = plan?.system ?? managedSystem();
const shell = process.env.WORKBENCH_ARTIFACT_KIND === "toolchain" ? "toolchain" : "default";
const installable = (root: string) => `path:${project}/${root}#devShells.${system}.${shell}`;
const options = [
  "--extra-experimental-features",
  "nix-command flakes",
  "--cores",
  String(plan?.cores ?? process.env.WORKBENCH_MANAGED_CORES),
  "--max-jobs",
  String(plan?.maxJobs ?? process.env.WORKBENCH_MANAGED_JOBS),
  "--system",
  system,
];
await withManagedProcesses(async (scope) => {
  const run = (args: string[], capture = false) => scope.run("nix", [...options, ...args], { capture });
  await run(["build", "--no-update-lock-file", "--no-link", ...roots.map(installable)]);
  const profiles: string[] = [];
  // Capture shell exports after the shared dependency graph has finished; no project commands run here.
  for (const [index, root] of roots.entries()) {
    const profile = plan?.roots[index]?.profile ?? join(output, "profiles", String(index));
    await run(["develop", "--no-update-lock-file", "--profile", profile, installable(root), "--command", "true"]);
    profiles.push(realpathSync(profile));
  }
  writeFileSync(join(output, "profiles.json"), JSON.stringify(profiles));
  if (process.env.WORKBENCH_MANAGED_PROFILE_EXPORT === "1") {
    await exportManagedProfiles(
      "nix",
      roots.map((path, index) => ({ path, profile: required(profiles[index], "Missing Nix profile") })),
      output,
    );
    return;
  }
  const image = (
    await run(
      [
        "build",
        "--impure",
        "--out-link",
        process.env.WORKBENCH_MANAGED_IMAGE_ROOT ?? join(output, "image-root"),
        "--print-out-paths",
        "--expr",
        `import ${project}/.devcontainer/nix/image.nix { system = ${JSON.stringify(system)}; project = ${JSON.stringify(project)}; output = ${JSON.stringify(output)}; }`,
      ],
      true,
    )
  ).trim();
  writeFileSync(join(output, "image-path"), `${image}\n`);
});
