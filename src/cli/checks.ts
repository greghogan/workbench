import { Command, Option } from "commander";
import { resolve } from "node:path";
import { compilerFamilies } from "../../scripts/compiler-catalog.mjs";
import { runGate, type GateOptions } from "../check-gates.js";
import type { CheckSelection } from "../check-plan.js";
import { runCheckSession } from "../checks.js";
import { compatibilityRuntimePlan, executeCompatibilityRuntime, runCompatibilityChecks } from "../ci-runtime.js";
import { ciTargets, groupedCIMatrix } from "../ci-targets.js";
import { ciMatrix } from "../ci.js";
import { collect, registerCommand } from "./commands.js";
import { listLocalCI, runLocalCI, type LocalCIOptions } from "../local-ci.js";
import { CIProvider } from "../ci-hosting.js";
import { setupCI, writeCIPipeline, type CISetupOptions } from "../ci-workflows.js";
import { validateHostedCI } from "../ci-validation.js";
import { RegistryProvider } from "../registry-management-contract.js";
import { prepareHostedCI, runHostedCIJob } from "../ci-hosted-jobs.js";
import { runHostedCITarget } from "../ci-hosted-target.js";
export function registerCheckCommands(program: Command, root: string): void {
  function gateCommand(name: "check" | "pre-commit" | "pre-push"): Command {
    const command = registerCommand(program, name)
      .description(
        name === "check"
          ? "Run the commit gate, then online checks when connectivity is available"
          : name === "pre-commit"
            ? "Run the complete offline commit gate"
            : "Run required online checks fresh before pushing",
      )
      .option("--list", "List selected checks without executing them")
      .addOption(new Option("--json", "Print the check plan as JSON (implies --list)").implies({ list: true }))
      .option("--verbose", "Stream full command output (also WORKBENCH_VERBOSE=1)")
      .option("--project <id>", "Select a project and descendant check roots")
      .option("--path <path>", "Select one registered language root")
      .option("--environment <environment>", "Override the selected execution environment")
      .option("--profile <profile>", "Use a named development profile")
      .addOption(
        new Option("--workspace <workspace>", "Override the profile's workspace").choices(["host", "devcontainer"]),
      )
      .argument("[root]", "Project tree (default: current project root)");
    if (name === "pre-push")
      command.option("--remote <name>", "Check prepared images for this configured push destination");
    if (name !== "pre-push")
      command
        .option("--no-cache", "Run checks fresh instead of reusing a matching successful gate")
        .addOption(new Option("--all", "Include excluded checks in the plan (implies --list)").implies({ list: true }))
        .addOption(new Option("--compiler <family>", "Select a supported C/C++ compiler").choices(compilerFamilies))
        .option("--compiler-version <version>", "Select an exact C/C++ compiler version")
        .option("--toolchain <name>", "Use a named compiler/runtime profile");
    if (name === "check")
      command
        .option("--stage <stage>", "Run only the commit or ci stage")
        .option(
          "--role <role>",
          "Include a role (repeatable); includes setup and skips structural validation",
          collect,
          [],
        )
        .option("--exclude-role <role>", "Exclude a role (repeatable); required setup cannot be excluded", collect, [])
        .option("--report <path>", "Write a versioned JSON execution report")
        .option(
          "--connectivity-url <url>",
          "HTTP(S) connectivity probe for the combined gate (default: https://api.osv.dev/)",
        );
    return command.action(async (requested: string | undefined, options: GateOptions) => {
      await runGate(requested ? resolve(requested) : root, name, options);
    });
  }
  const checks = gateCommand("check");
  gateCommand("pre-commit");
  gateCommand("pre-push");
  registerCommand(program, "checks-session", { hidden: true })
    .argument("<directory>")
    .argument("<environment>")
    .argument("<selection>")
    .argument("<control>")
    .argument("[log-directory]")
    .action(
      async (
        directory: string,
        environment: string,
        selection: string,
        control: string,
        logDirectory: string | undefined,
      ) => {
        try {
          await runCheckSession(
            root,
            JSON.parse(selection) as CheckSelection,
            directory,
            environment,
            control,
            logDirectory,
          );
        } finally {
          if (process.connected) process.disconnect();
        }
      },
    );
  const ci = registerCommand(program, "ci")
    .description("Rehearse configured Linux x64 CI targets and release verification")
    .option("--path <path>", "Select one configured Linux CI root")
    .option("--target <ids...>", "Select target IDs from the rehearsal plan")
    .option("--json", "Print the structured rehearsal plan without execution")
    .option("--no-release", "Run CI checks without preparing and verifying release artifacts")
    .option("--plan", "Print the rehearsal plan without building or running containers")
    .action(async (options: LocalCIOptions & { plan?: boolean; json?: boolean }) => {
      if (options.plan || options.json) listLocalCI(root, options, options.json);
      else await runLocalCI(root, options);
    });
  ci.command("setup")
    .description("Configure a GitHub or GitLab CI destination and create its project-owned workflow")
    .option("--remote <name>", "Git remote used for publication", "origin")
    .addOption(
      new Option("--provider <provider>", "Required for self-hosted servers").choices(Object.values(CIProvider)),
    )
    .option("--registry <namespace>", "Override the paired registry HOST/NAMESPACE")
    .option(
      "--repository <url>",
      "Canonical HTTPS project identity when the Git transport uses an alias or different port",
    )
    .addOption(
      new Option("--registry-management <provider>", "Bind registry inventory separately from CI hosting").choices([
        ...Object.values(RegistryProvider),
        "none",
      ]),
    )
    .option("--registry-api-host <host>", "Registry management API hostname and optional port")
    .option("--registry-project <path>", "Registry management project independent of the Git destination")
    .option("--plan", "Preview the destination and planned file changes")
    .action((options: CISetupOptions) => {
      setupCI(root, options);
    });
  ci.command("pipeline")
    .description("Generate the complete configured target pipeline for a CI destination")
    .requiredOption("--destination <remote>")
    .requiredOption("--output <path>")
    .option("--group <id>", "Generate the operation matrix for one preparation group")
    .action((options: { destination: string; output: string; group?: string }) => {
      writeCIPipeline(root, options.destination, options.output, options.group);
    });
  ci.command("prepare")
    .description("Prepare verified inputs once for a native-platform CI group")
    .argument("<group>")
    .requiredOption("--destination <remote>")
    .requiredOption("--output <path>")
    .action((group: string, options: { destination: string; output: string }) =>
      prepareHostedCI(root, group, options.destination, options.output),
    );
  ci.command("run")
    .description("Run one complete configured CI operation using verified preparation")
    .argument("<group>")
    .argument("<job>")
    .requiredOption("--destination <remote>")
    .requiredOption("--prepared <path>")
    .option("--reports <path>", "Retain operation results and diagnostics", ".workbench-ci/reports")
    .action((group: string, job: string, options: { destination: string; prepared: string; reports: string }) =>
      runHostedCIJob(root, group, job, options.destination, options.prepared, options.reports),
    );
  ci.command("validate")
    .description("Validate generated CI documents locally or explicitly through GitLab's schema API")
    .requiredOption("--destination <remote>")
    .option("--live", "Use the authenticated GitLab server without creating a pipeline")
    .action(async (options: { destination: string; live?: boolean }) => {
      console.log(JSON.stringify(await validateHostedCI(root, options.destination, options.live), null, 2));
    });
  ci.command("target")
    .description("Execute one configured CI target on its native platform")
    .argument("<id>")
    .requiredOption("--destination <remote>")
    .option("--reports <path>", "Retain target results and diagnostics", ".workbench-ci/reports")
    .action((id: string, options: { destination: string; reports: string }) =>
      runHostedCITarget(root, id, options.destination, options.reports),
    );
  registerCommand(program, "compatibility-exec", { hidden: true })
    .argument("<path>")
    .argument("<runtime>")
    .argument("<version>")
    .argument("[command...]")
    .option("--plan")
    .option("--checks", "Run declared compatibility commands")
    .action(
      async (
        path: string,
        runtime: string,
        version: string,
        command: string[],
        options: { plan?: boolean; checks?: boolean },
      ) => {
        if (options.checks && (options.plan || command.length))
          throw new Error("--checks selects configured commands; do not supply --plan or command arguments");
        if (options.plan) {
          if (command.length) throw new Error("compatibility --plan does not execute a command");
          console.log(JSON.stringify(compatibilityRuntimePlan(root, path, runtime, version)));
        } else if (options.checks) await runCompatibilityChecks(root, path, runtime, version);
        else await executeCompatibilityRuntime(root, path, runtime, version, command);
      },
    );
  checks
    .command("matrix")
    .description("Print configured CI matrices as JSON")
    .addOption(new Option("--grouped", "Group roots sharing CI setup").conflicts("targets"))
    .option("--targets", "Print exact per-root tool and environment selections")
    .action((options: { grouped?: boolean; targets?: boolean }) => {
      if (options.targets) console.log(JSON.stringify(ciTargets(root)));
      else {
        const matrix = ciMatrix(root);
        console.log(JSON.stringify(options.grouped ? groupedCIMatrix(matrix) : matrix));
      }
    });
}
