import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CILifecycle, executeCI } from "./ci-lifecycle.mjs";
import { readCITargets } from "./ci-contract.mjs";
import { assertOperationCoverage, nativeCIJobs, operationPhases, CIOperation } from "./ci-operations.mjs";
import { readAcquiredCIImage } from "./ci-image-contract.mjs";
import { readCandidate } from "./ci-candidate.mts";
import { runSucceeded } from "./ci-results.mjs";
import { executeCITargets } from "./ci-execution.mjs";
import { record, required, string, stringRecord } from "./values.mjs";
import { acquireRegistryImage } from "./image-acquisition.mts";
import { runCIEntry } from "./ci-errors.mts";

const lifecycle = new CILifecycle();
const temporary = required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required");
const cli = join(process.cwd(), "bin/workbench.mjs");
const inspect = (...args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const run = async (args: string[], env = process.env) => {
  await lifecycle.checkpoint();
  return executeCI(process.execPath, args, { env });
};
const output = (name: string, value: unknown) => {
  appendFileSync(
    required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required"),
    `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
};

await runCIEntry("Native platform operation", async () => {
  try {
    await run([cli, "project", "add", "."]);
    const raw = record(JSON.parse(required(process.env.CI_MATRIX, "CI_MATRIX is required")), "Invalid platform matrix");
    const os = string(raw.os, "Missing OS"),
      architecture = string(raw.architecture, "Missing architecture");
    const expectedOS =
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
    if (os !== expectedOS || architecture !== process.arch) throw new Error("CI requires native platform execution");
    const targets = readCITargets(JSON.parse(inspect("check", "matrix", "--targets"))).filter(
      (target) => target.os === os && target.architecture === architecture && target.kind !== "environment",
    );
    const jobs = nativeCIJobs(targets, os, architecture);
    assertOperationCoverage(targets, jobs);
    const encoded = inspect("config", "get", "ci.images", "--scope", "project");
    const profile =
      process.platform === "linux" && encoded !== "<unset>"
        ? stringRecord(JSON.parse(encoded), "Invalid CI images").native
        : undefined;
    const operation = process.argv[2];
    if (operation === "plan") {
      output("container", Boolean(profile).toString());
      output("matrix", {
        include: jobs.map((job) => ({ id: job.artifact, operation: job.operation, label: job.label })),
      });
    } else if (operation === "prepare") {
      const directory = join(temporary, "platform-inputs");
      mkdirSync(directory, { recursive: true });
      if (profile) {
        await run([cli, "tools", "install", "--devcontainer"]);
        const metadata = join(directory, "image.json");
        await run([cli, "ci-image-acquire", profile, "--output", metadata]);
      } else {
        // Prepare reusable installations first; operation jobs reacquire tools omitted by cache retention.
        for (const job of jobs)
          for (const target of job.targets) {
            if (!operationPhases(target, job.operation).includes("native-install")) continue;
            const selection = target.kind === "native" && target.toolchain ? ["--toolchain", target.toolchain] : [];
            await run([cli, "tools", "install", "--path", target.path, "--exclude-tool", "miri", ...selection]);
          }
        writeFileSync(join(directory, "host.json"), JSON.stringify({ version: 1, os, architecture }));
      }
    } else if (operation === "run") {
      const candidate = required(process.env.WORKBENCH_CI_CANDIDATE, "Missing candidate directory");
      readCandidate(
        candidate,
        required(process.env.GITHUB_REPOSITORY, "Missing repository"),
        required(process.env.GITHUB_SHA, "Missing revision"),
      );
      const job = required(
        jobs.find((item) => item.artifact === process.env.CI_OPERATION),
        "Operation is not configured for this platform",
      );
      const reports = join(temporary, "workbench-reports");
      mkdirSync(reports, { recursive: true });
      if (profile) {
        await run([cli, "tools", "install", "--devcontainer"]);
        const directory = join(temporary, "platform-inputs");
        const value = readAcquiredCIImage(JSON.parse(readFileSync(join(directory, "image.json"), "utf8")));
        if (value.profile !== profile || value.platform !== `linux-${architecture}`)
          throw new Error("Prepared CI inputs belong to another platform or profile");
        const image = value.image;

        const published = value.published;
        await lifecycle.checkpoint();
        await acquireRegistryImage(published, { profile, quiet: false });
        const actual = await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", published], {
          capture: true,
        });
        if (actual.trim() !== image) throw new Error("Transferred image differs from the acquired image");
        // Every network partition receives its own retained reports. Phase ownership remains unchanged.
        for (const network of job.operation === CIOperation.Checks &&
        job.targets.every((target) => target.kind === "native")
          ? ["offline", "online"]
          : ["all"]) {
          const partition = join(reports, network);
          mkdirSync(partition);
          writeFileSync(join(partition, "targets.json"), JSON.stringify(job.targets));
          // The same exact portable candidate is mounted with reports, outside the source checkout.
          const { cpSync } = await import("node:fs");
          cpSync(candidate, join(partition, "candidate"), { recursive: true });
          await run([
            cli,
            "ci-image-exec",
            profile,
            "--image",
            image,
            "--reports",
            partition,
            "--network",
            network === "offline" ? "none" : "host",
            "--env-json",
            JSON.stringify({
              RUNNER_TEMP: "/reports",
              WORKBENCH_CI_TARGETS: "/reports/targets.json",
              WORKBENCH_CI_OPERATION: job.operation,
              WORKBENCH_CI_CHECK_NETWORK: network,
              WORKBENCH_CI_CANDIDATE: "/reports/candidate",
              ...(process.env.WORKBENCH_COVERAGE_BASE
                ? { WORKBENCH_COVERAGE_BASE: process.env.WORKBENCH_COVERAGE_BASE }
                : {}),
            }),
            "--",
            "node",
            "{workbench}/scripts/ci-linux/run.mjs",
          ]);
        }
      } else {
        const result = await executeCITargets({
          targets: job.targets,
          workspace: process.cwd(),
          distribution: process.cwd(),
          reports,
          resultFile: join(reports, "results.json"),
          operation: job.operation,
          lifecycle,
          installPrerequisites: true,
        });
        if (!runSucceeded(result))
          throw new Error(
            result.targets
              .filter((target) => !target.success)
              .map((target) => `${target.id}: ${target.error ?? "operation failed"}; reports: ${target.report}`)
              .join("\n"),
          );
      }
    } else throw new Error("Select platform plan, prepare, or run");
  } finally {
    lifecycle.close();
  }
});
