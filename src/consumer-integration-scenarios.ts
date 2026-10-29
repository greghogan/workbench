import { writeDiagnosticText } from "../scripts/diagnostics.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConsumerCommands } from "./consumer-integration-runner.js";
import { describeError } from "./diagnostics.js";
import type { ConsumerCase, ConsumerSuiteReport, ConsumerReportRecorder } from "./consumer-integration-report.js";
import type { CheckCancellation } from "./check-cancellation.js";
import type { ProcessLock } from "./process-lock.js";

/** Failed prerequisites block dependent cases without concealing independent evidence. */
export class ConsumerScenarios {
  constructor(
    private readonly report: ConsumerSuiteReport,
    private readonly recorder: ConsumerReportRecorder,
    private readonly cancellation: CheckCancellation,
    private readonly label: string,
  ) {}
  async run<T>(name: string, action: () => Promise<T>, requires: string[] = []): Promise<T | undefined> {
    this.cancellation.checkpoint();
    if (this.report.cases.some((entry) => entry.name === name)) throw new Error(`Duplicate consumer case: ${name}`);
    const blockedBy = requires.filter((prerequisite) => {
      const previous = this.report.cases.find((entry) => entry.name === prerequisite);
      if (!previous) throw new Error(`Unknown prerequisite: ${prerequisite}`);
      return previous.status !== "passed";
    });
    const entry: ConsumerCase = { name, status: "running", durationMs: 0, started: new Date().toISOString() };
    this.report.cases.push(entry);
    if (blockedBy.length) {
      entry.status = "blocked";
      entry.blockedBy = blockedBy;
      entry.finished = new Date().toISOString();
      this.recorder.save();
      console.log(`Consumer integration (${this.label}): ${name} blocked by ${blockedBy.join(", ")}`);
      return undefined;
    }
    this.recorder.save();
    const started = performance.now();
    console.log(`Consumer integration (${this.label}): ${name}`);
    try {
      const value = await action();
      entry.status = "passed";
      return value;
    } catch (error) {
      entry.status = this.cancellation.cancelled ? "cancelled" : "failed";
      entry.error = describeError(error);
      writeDiagnosticText(`${name}: ${entry.error}`);
      this.cancellation.checkpoint();
      return undefined;
    } finally {
      entry.durationMs = performance.now() - started;
      entry.finished = new Date().toISOString();
      this.recorder.save();
    }
  }
}

export async function runConsumerSuite(
  options: {
    report: ConsumerSuiteReport;
    recorder: ConsumerReportRecorder;
    output: string;
    cancellation: CheckCancellation;
    owner: ProcessLock;
    label: string;
  },
  exercise: (commands: ConsumerCommands, scenarios: ConsumerScenarios) => Promise<void>,
): Promise<void> {
  const { report, recorder, cancellation } = options;
  report.status = "running";
  recorder.save();
  try {
    const logs = join(options.output, "commands");
    mkdirSync(logs, { recursive: true });
    const commands = new ConsumerCommands(logs, cancellation.signal, {
      owner: options.owner,
      observe: () => {
        recorder.save();
      },
    });
    report.commands = commands.results;
    await exercise(commands, new ConsumerScenarios(report, recorder, cancellation, options.label));
    report.status =
      report.cases.length > 0 && report.cases.every((entry) => entry.status === "passed") ? "passed" : "failed";
  } catch (error) {
    report.status = cancellation.cancelled ? "cancelled" : "failed";
    report.error = describeError(error);
    cancellation.checkpoint();
  } finally {
    recorder.save();
  }
}
