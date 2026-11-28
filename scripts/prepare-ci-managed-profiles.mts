import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { managedSystem } from "../app/src/core/execution/environments/managed/managed-system.mjs";
import { required, strings } from "../app/src/core/runtime/values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";

const [builder, output, cores, jobs, ...selected] = process.argv.slice(2);
if ((builder !== "guix" && builder !== "nix") || !output || !cores || !jobs || !selected.length)
  throw new Error("Expected a managed CI builder, output directory, resource allocation and selected roots");
const original = required(process.env.WORKBENCH_ENVIRONMENTS, "Missing prepared toolchain profiles");
const roots = strings(JSON.parse(readFileSync(join(original, "roots.json"), "utf8")), "Invalid prepared roots");
for (const root of selected) if (!roots.includes(root)) throw new Error(`The toolchain image does not cover '${root}'`);

mkdirSync(output);
symlinkSync(join(original, "roots.json"), join(output, "roots.json"));
if (builder === "guix") symlinkSync(join(original, "runtimes"), join(output, "runtimes"));
await withManagedProcesses(async (scope) => {
  for (const [index, root] of roots.entries()) {
    const profile = join(output, String(index));
    if (!selected.includes(root)) {
      symlinkSync(join(original, String(index)), profile);
      continue;
    }
    const project = join(process.cwd(), root);
    if (builder === "guix") {
      const guix = join(original, "runtimes", String(index), "bin/guix");
      await scope.run(
        guix,
        [
          "package",
          `--profile=${profile}`,
          `--manifest=${join(project, "manifest.scm")}`,
          `--cores=${cores}`,
          `--max-jobs=${jobs}`,
        ],
        { env: { ...process.env, WORKBENCH_ARTIFACT_KIND: "development" } },
      );
    } else {
      await scope.run("nix", [
        "--extra-experimental-features",
        "nix-command flakes",
        "--option",
        "flake-registry",
        "",
        "--cores",
        cores,
        "--max-jobs",
        jobs,
        "develop",
        "--no-update-lock-file",
        "--profile",
        profile,
        `path:${project}#devShells.${managedSystem()}.default`,
        "--command",
        "true",
      ]);
    }
  }
});
