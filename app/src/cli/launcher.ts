import { projectPaths } from "../core/projects/project-paths.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { minimumCliNode } from "../core/distribution/node-runtimes.mjs";
import { diagnosticOptions } from "../core/diagnostics/diagnostic-contract.mjs";
import { clipped, formatDiagnosticMessage } from "../core/diagnostics/diagnostic-text.mjs";
import { writeDiagnosticText } from "../core/diagnostics/diagnostics.mjs";
import { npmWorkbench } from "../core/distribution/launcher-acquisition.js";
import { executingToolPin, readToolPin, toolProjectRoot } from "../core/distribution/launcher-identity.js";
import { ownsStartupRuntime } from "../core/distribution/launcher-runtime.js";
import { projectRegistration, Registration } from "../core/projects/project-registry.js";
import { enableRuntimeCompileCache } from "../core/storage/node-compile-cache.js";
import { sameToolPin, specificationPin, toolSpecification, type ToolPin } from "../core/toolchains/tool-pin.js";
import { commandAdmission, integrationRecovery } from "./commands.js";
import { approveProjectRegistration, registrationInstruction } from "./project-admission.js";

export function formatFailure(error: unknown): string {
  return formatDiagnosticMessage("workbench:", clipped(error instanceof Error ? error.message : String(error)).text);
}

export { minimumCliNode } from "../core/distribution/node-runtimes.mjs";

/** Shared diagnostic options must not change which executable an install command selects. */
export function launcherCommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--plain" || argument === "--no-plain" || argument === "--no-pager") continue;
    const specification = diagnosticOptions.find(
      (option) => argument === option.flag || argument?.startsWith(`${option.flag}=`),
    );
    if (specification) {
      if (argument === specification.flag) index++;
      continue;
    }
    return argument;
  }
  return undefined;
}

/** Dispatch before the CLI parses options; a user-installed launcher always has a default pin. */
export async function launch(args: string[], defaultPin?: ToolPin, distribution?: string): Promise<void> {
  const version = process.versions.node.split(".").map(Number);
  const atLeast = (major: number, minor: number, patch: number) =>
    (version[0] ?? 0) > major ||
    (version[0] === major && ((version[1] ?? 0) > minor || (version[1] === minor && (version[2] ?? 0) >= patch)));
  if (!atLeast(18, 20, 8)) throw new Error("Node.js 18.20.8 or newer is required to bootstrap Workbench");
  const own = distribution ? executingToolPin(distribution) : undefined;
  if (own) process.env.WORKBENCH_EXECUTING_SPEC = toolSpecification(own);
  const root = toolProjectRoot();
  const original =
    process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1" && process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      : root;
  const command = launcherCommand(args);
  const child = command ? launcherCommand(args.slice(args.indexOf(command) + 1)) : undefined;
  const recovery = integrationRecovery(command ?? "", {
    abort: args.includes("--abort"),
    status: args.includes("--status"),
  });
  const admission = commandAdmission([command, child].filter(Boolean).join(" "));
  const canSelectProject = !recovery && root;
  const pin =
    command === "install" || command === "project" || command === "update"
      ? defaultPin
      : ((canSelectProject ? readToolPin(root) : undefined) ?? defaultPin);
  const [major = 0, minor = 0, patch = 0] = minimumCliNode.split(".").map(Number);
  if (distribution && !atLeast(major, minor, patch)) {
    if (ownsStartupRuntime()) {
      const { default: bootstrap } = (await import(pathToFileURL(join(distribution, "bundle/bootstrap.cjs")).href)) as {
        default: { restartWithStartupRuntime: (distribution: string) => Promise<boolean> };
      };
      if (await bootstrap.restartWithStartupRuntime(distribution)) return;
    }
    throw new Error(`the selected environment requires Node.js ${minimumCliNode} or newer to run the Workbench CLI`);
  }
  if (pin) {
    const spec = toolSpecification(pin);
    const executing = specificationPin(process.env.WORKBENCH_EXECUTING_SPEC);
    if (!distribution || !executing || !sameToolPin(executing, pin)) {
      await npmWorkbench(spec, args);
      return;
    }
  }
  if (!distribution) throw new Error("No project or default Workbench revision is configured");
  // The selected application owns registration state; an outer launcher must not write another release's schema.
  if (!recovery && root && existsSync(join(root, projectPaths.projects))) {
    const inspection = args.some((argument) => ["--help", "-h", "--help-all"].includes(argument));
    const independentService = command === "serve" && (args.includes("--demo") || args.includes("--service"));
    if (command && admission.registration && !inspection && !independentService)
      await approveProjectRegistration(original ?? root);
    else if (
      projectRegistration(original ?? root) === Registration.Declined &&
      command !== "complete" &&
      !admission.internal
    ) {
      writeDiagnosticText(registrationInstruction(original ?? root));
      process.env.WORKBENCH_REGISTRATION_NOTICE = original ?? root;
    }
  }
  delete process.env.WORKBENCH_LAUNCH_CHAIN;
  process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
  enableRuntimeCompileCache();
  await import(pathToFileURL(join(distribution, "bundle/main.cjs")).href);
}
