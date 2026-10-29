import { required } from "./values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { importManagedImage } from "./managed-image-import.mjs";
import { validateManagedPlan } from "./managed-contract.mjs";
import { prepareGuixProfiles } from "./prepare-guix-profiles.mjs";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const [builder, image] = process.argv.slice(2);
if ((builder !== "nix" && builder !== "guix") || !image) throw new Error("Expected nix or guix and an output image");
const output = required(process.env.WORKBENCH_MANAGED_OUTPUT, "Missing managed output");
const plan = validateManagedPlan(JSON.parse(readFileSync(join(output, "host-profiles.json"), "utf8")));
if (plan.builder !== builder || plan.output !== output) throw new Error("Managed plan does not match this invocation");
await withManagedProcesses(async (scope) => {
  const run = (command: string, args: string[], capture = false) => scope.run(command, args, { capture });
  scope.defer(() => {
    rmSync(plan.imageRoot, { force: true });
  });
  // These are operation-owned roots; Guix refuses to reuse an existing --root link.
  rmSync(plan.imageRoot, { force: true });
  process.env.WORKBENCH_MANAGED_IMAGE_ROOT = plan.imageRoot;
  if (builder === "guix") {
    const env = await prepareGuixProfiles(plan, scope);
    await scope.run("sh", [".devcontainer/guix/prepare.sh"], { env });
  } else {
    process.env.WORKBENCH_MANAGED_PLAN = join(output, "host-profiles.json");
    await run(process.execPath, [join(import.meta.dirname, "prepare-nix-profiles.mjs")]);
  }
  const archive = readFileSync(join(output, "image-path"), "utf8").trim();
  if (!archive.startsWith(builder === "guix" ? "/gnu/store/" : "/nix/store/"))
    throw new Error("Invalid managed image archive");
  await importManagedImage(scope, archive, image);
});
