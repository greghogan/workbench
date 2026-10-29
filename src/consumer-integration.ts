import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareWorkbenchPackage } from "./package.js";
import { verifyWorkbenchPackage } from "./package-verify.js";
import { CheckCancellation } from "./check-cancellation.js";
import { userDirectory } from "./storage.js";
import { describeError } from "./diagnostics.js";
import { consumerFaults } from "./consumer-integration-fixtures.js";
import { exerciseConsumerProfile } from "./consumer-integration-profile.js";
import { ConsumerReportRecorder, retainConsumerDiagnostics } from "./consumer-integration-report.js";
import { runConsumerSuite } from "./consumer-integration-scenarios.js";
import { exerciseConsumerInstallations } from "./consumer-integration-installation.js";
import { exerciseCIHosting } from "./consumer-ci.js";
import { exerciseSourceCheckout } from "./consumer-source.js";
import { consumerEnvironment } from "./consumer-environment.js";
import { readDistributionManifest } from "./distribution-source-manifest.js";
import { executeConsumerProfiles, planConsumerProfiles } from "./consumer-integration-plan.js";
import { createOwnedScratch, type OwnedScratch } from "../scripts/owned-scratch.mjs";
import type { CompilerFamily } from "../scripts/compiler-catalog.mjs";

export interface ConsumerIntegrationOptions {
  hostingOnly?: boolean;
  artifacts?: string;
  output?: string;
  languages?: string[];
  coldCache?: boolean;
  compilers?: CompilerFamily[];
}
/** One archive and package installation serve all profiles; independent profile failures do not suppress evidence. */
export async function runConsumerIntegration(options: ConsumerIntegrationOptions = {}): Promise<void> {
  const languages = options.languages ?? Object.keys(consumerFaults);
  if (languages.some((language) => !Object.hasOwn(consumerFaults, language)))
    throw new Error("Unsupported integration language");
  const profiles = options.hostingOnly ? [] : planConsumerProfiles(languages, options.compilers);
  const source = process.cwd(),
    parent = join(source, "build/consumer-integration");
  if (!options.output) mkdirSync(parent, { recursive: true });
  const output = options.output ? resolve(options.output) : mkdtempSync(join(parent, "run-"));
  if (options.output) mkdirSync(output);
  const recorder = new ConsumerReportRecorder(join(output, "results.json")),
    report = recorder.result;
  for (const profile of profiles) recorder.profile(profile.id, profile.languages, profile.compiler);
  const cancellation = new CheckCancellation("Consumer integration");
  let scratch: OwnedScratch | undefined;
  let primary: unknown;
  try {
    // Keep owned build storage shallow enough for Windows compiler-generated paths.
    scratch = createOwnedScratch(userDirectory("cache"), "ci");
    const scope = scratch;
    const cache = {
      tools: options.coldCache ? join(scope.directory, "cold-cache") : userDirectory("cache"),
      builds: scope.directory,
    };
    let artifacts = options.artifacts;
    if (!artifacts) {
      await prepareWorkbenchPackage(source, { output: scratch.directory });
      artifacts = scratch.directory;
    }
    cancellation.checkpoint();
    report.artifactSha256 = createHash("sha256")
      .update(readFileSync(join(artifacts, "workbench-artifacts/workbench.tar.gz")))
      .digest("hex");
    report.phase = "verifying";
    recorder.save();
    await verifyWorkbenchPackage(
      artifacts,
      source,
      async (installed) => {
        const manifest = readDistributionManifest(installed.directory);
        report.sourceManifestSha256 = manifest.sha256;
        report.phase = "installations";
        recorder.save();
        await runConsumerSuite(
          {
            report: report.installations,
            recorder,
            output: join(output, "installations"),
            cancellation,
            owner: scope.owner,
            label: "installations",
          },
          async (commands, scenarios) => {
            const temporary = join(installed.temporary, "installations");
            mkdirSync(temporary, { recursive: true });
            const fixture = { ...installed, temporary };
            if (!options.hostingOnly) {
              await exerciseConsumerInstallations(
                fixture,
                consumerEnvironment(fixture, cache),
                commands,
                scenarios,
                manifest.contents,
              );
              await exerciseSourceCheckout({
                source,
                temporary,
                environment: consumerEnvironment(fixture, cache),
                commands,
                scenarios,
                signal: cancellation.signal,
                owner: scope.owner,
              });
            }
            await exerciseCIHosting(fixture, source, consumerEnvironment(fixture, cache), commands, scenarios);
          },
        );
        report.phase = "profiles";
        recorder.save();
        await executeConsumerProfiles(
          profiles,
          cancellation.signal,
          async (profile, index) => {
            cancellation.checkpoint();
            const status = report.profiles[index];
            if (!status) throw new Error("Missing consumer profile");
            const temporary = join(installed.temporary, "profiles", profile.id);
            mkdirSync(temporary, { recursive: true });
            await exerciseConsumerProfile(
              { ...installed, temporary },
              installed.temporary,
              profile,
              cache,
              join(output, profile.id),
              cancellation,
              scope.owner,
              status,
              recorder,
            );
          },
          (error, index) => {
            const status = report.profiles[index];
            if (!status) throw new Error("Missing consumer profile");
            status.status = cancellation.cancelled ? "cancelled" : "failed";
            status.error = describeError(error);
            recorder.save();
          },
        );
      },
      {
        signal: cancellation.signal,
        scope,
        onCleanupIssue: (error) => {
          report.cleanupErrors.push(describeError(error));
          recorder.save();
        },
      },
    );
    if (report.installations.status !== "passed" || report.profiles.some((profile) => profile.status !== "passed"))
      throw new Error(
        `Consumer integration failed: ${[
          ...(report.installations.status !== "passed" ? ["installations"] : []),
          ...report.profiles.filter((profile) => profile.status !== "passed").map((profile) => profile.id),
        ].join(", ")}`,
      );
    report.success = true;
    report.status = "passed";
  } catch (error) {
    primary = error;
    report.error = describeError(error);
    report.status = cancellation.cancelled ? "cancelled" : "failed";
  } finally {
    report.phase = "cleanup";
    try {
      if (scratch) {
        scratch.owner.assertIdle();
        retainConsumerDiagnostics(scratch.directory, output);
      }
    } catch (error) {
      report.cleanupErrors.push(describeError(error));
    }
    try {
      scratch?.release();
    } catch (error) {
      report.cleanupErrors.push(describeError(error));
    }
    cancellation.close();
    if (report.cleanupErrors.length) {
      report.success = false;
      if (report.status !== "cancelled") report.status = "failed";
    }
    report.finished = new Date().toISOString();
    report.phase = "complete";
    try {
      recorder.save();
    } catch (error) {
      report.cleanupErrors.push(describeError(error));
    }
    if (!report.success && existsSync(join(output, "check-logs")))
      console.error(`Retained consumer check logs: ${join(output, "check-logs")}`);
    console.log(`Consumer integration results: ${join(output, "results.json")}`);
  }
  if (primary || report.cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...report.cleanupErrors.map((error) => new Error(error))],
      report.error || "Consumer integration finalization failed",
      { cause: primary },
    );
}
