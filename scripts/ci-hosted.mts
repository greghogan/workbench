import { CILifecycle, executeCI } from "./ci-lifecycle.mjs";
import { runCIEntry } from "./ci-errors.mts";
import { readAcquiredCIImage } from "./ci-image-contract.mjs";
import { required, record, string, strings, stringRecord } from "./values.mjs";

interface HostedMatrix {
  paths: string[];
  os?: string;
  architecture?: string;
  environment?: string;
  runtime?: string;
  version?: string;
}
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { targetEnvironment, targetPhases, readCITargets } from "./ci-contract.mjs";
import { createRunReport, runReportedTargetAsync, runSucceeded, writeRunReport } from "./ci-results.mjs";

const lifecycle = new CILifecycle();
await runCIEntry("Hosted CI operation", async () => {
  try {
    const raw = record(JSON.parse(required(process.env.CI_MATRIX, "CI_MATRIX is required")), "Invalid hosted matrix");
    const matrix: HostedMatrix = { paths: strings(raw.paths, "Missing matrix paths") };
    for (const name of ["os", "architecture", "environment", "runtime", "version"] as const)
      if (raw[name] !== undefined) matrix[name] = string(raw[name], "Invalid matrix field");
    const kind = process.argv[2];
    const cli = join(process.cwd(), "bin/workbench.mjs");
    const inspect = (...args: string[]) => executeCI(process.execPath, [cli, ...args], { capture: true });
    async function run(args: string[], env = process.env) {
      await lifecycle.checkpoint();
      await executeCI(process.execPath, args, { env });
    }
    await run([cli, "project", "add", process.cwd()]);
    const catalog = readCITargets(JSON.parse(await inspect("check", "matrix", "--targets")));
    const targets = catalog.filter((target) => {
      if (!matrix.paths.includes(target.path)) return false;
      if (kind === "native" && target.kind === "compatibility")
        return target.os === matrix.os && target.architecture === matrix.architecture;
      if (target.kind !== kind) return false;
      if (kind === "native") return target.os === matrix.os && target.architecture === matrix.architecture;
      if (kind === "environment") return target.environment === matrix.environment;
      return (
        target.runtime === matrix.runtime &&
        target.version === matrix.version &&
        target.architecture === (matrix.architecture ?? "x64")
      );
    });
    if (!targets.length) throw new Error("Hosted job has no configured targets");
    const encoded = (await inspect("config", "get", "ci.images", "--scope", "project")).trim();
    const images = encoded === "<unset>" ? {} : stringRecord(JSON.parse(encoded), "Invalid CI images");
    const builder =
      kind === "environment"
        ? matrix.environment === "nix-docker"
          ? "nix"
          : required(matrix.environment, "Missing matrix environment")
        : "native";
    const profile = process.platform === "linux" ? images[builder] : undefined;
    if (["nix", "guix"].includes(builder) && !profile)
      throw new Error(`${builder} CI requires a prepared profile in ci.images`);
    const reports = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "workbench-reports");
    mkdirSync(reports, { recursive: true });
    if (profile) {
      if (["nix", "guix"].includes(builder)) await run([cli, "development", "images", profile, "--require"]);
      await run([cli, "tools", "install", "--devcontainer"]);
      const metadata = join(reports, "image.json");
      await run([cli, "ci-image-acquire", profile, "--output", metadata]);
      const acquired = readAcquiredCIImage(JSON.parse(readFileSync(metadata, "utf8")));
      const image = acquired.image;
      writeFileSync(join(reports, "targets.json"), JSON.stringify(targets));
      for (const network of kind === "environment" ? ["offline", "online"] : ["all"]) {
        const partition = kind === "environment" ? join(reports, network) : reports;
        mkdirSync(partition, { recursive: true });
        writeFileSync(join(partition, "targets.json"), JSON.stringify(targets));
        await run([
          cli,
          "ci-image-exec",
          profile,
          "--image",
          image,
          "--network",
          network === "offline" ? "none" : "host",
          "--reports",
          partition,
          "--env-json",
          JSON.stringify({
            RUNNER_TEMP: "/reports",
            WORKBENCH_CI_TARGETS: "/reports/targets.json",
            WORKBENCH_CI_CHECK_NETWORK: network,
          }),
          "--",
          "node",
          "{workbench}/scripts/ci-linux/run.mjs",
        ]);
      }
    } else {
      if (builder === "devcontainer") await run([cli, "tools", "install", "--devcontainer"]);
      const result = createRunReport(
        targets.map((target) => target.id),
        reports,
      );
      const save = () => {
        writeRunReport(join(reports, "results.json"), result);
      };
      save();
      for (const target of targets) {
        await runReportedTargetAsync(
          result,
          target.id,
          join(process.cwd(), target.path, "coverage"),
          async (report) => {
            const env = { ...process.env, ...targetEnvironment(target), RUNNER_TEMP: report };
            for (const phase of targetPhases(target)) await run(["scripts/ci-run.mjs", phase], env);
          },
        );
        save();
      }
      if (!runSucceeded(result))
        throw new Error(
          result.targets
            .filter((target) => !target.success)
            .map((target) => `${target.id}: ${target.error ?? "operation failed"}; reports: ${target.report}`)
            .join("\n"),
        );
    }
  } finally {
    lifecycle.close();
  }
});
