import { RetainedProcessLogs } from "../../storage/retained-process-logs.js";
import {
  writeDiagnosticText,
  LogLevel,
  LogCompression,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  describeError,
} from "../../diagnostics/diagnostics.mjs";
import { compressLogFile, logRetention } from "../../storage/logs/log-storage.js";
import { processFailure } from "../../runtime/process-outcome.mjs";
import { spawn, type ChildProcess } from "node:child_process";
import { positiveInteger } from "../checks/cpu-budget.mjs";
import { CILifecycle } from "./support/ci-lifecycle.mjs";

export interface CIInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface CIWorker {
  id: string;
  log: string;
  start: () => Promise<CIInvocation>;
  finish: (error?: Error) => Promise<void>;
}

/** Bound preparation and execution together; drain active jobs before cleanup. */
export async function runCIWorkers(
  workers: CIWorker[],
  concurrency: number,
  lifecycle: CILifecycle,
  root?: string,
): Promise<void> {
  positiveInteger(concurrency, "CI worker concurrency");
  let next = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, workers.length) }, async () => {
      while (next < workers.length && (await lifecycle.ready())) {
        const worker = workers[next++];
        if (!worker) break;
        writeDiagnosticText(`Starting CI target ${worker.id}`);
        let error: Error | undefined;
        let child: ChildProcess | undefined;
        const retained = new RetainedProcessLogs(worker.log, worker.log + ".stderr", (failure) => {
          error = error
            ? new AggregateError([error, failure], "CI execution and log retention failed")
            : failure instanceof Error
              ? failure
              : new Error(String(failure));
        });
        try {
          await retained.open();
          const invocation = await worker.start();
          if (error) throw error;
          await new Promise<void>((resolve) => {
            child = spawn(invocation.command, invocation.args, {
              env: invocation.env,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            if (child.stdout) retained.attach(child.stdout, "stdout");
            if (child.stderr) retained.attach(child.stderr, "stderr");
            child.on("error", (failure) => {
              error ??= failure;
            });
            child.once("close", (code, signal) => {
              if (code !== 0 || error)
                error = processFailure(`CI worker ${worker.id}`, {
                  pid: child?.pid ?? 0,
                  status: code,
                  signal,
                  ...(error ? { error } : {}),
                });
              resolve();
            });
          });
        } catch (failure) {
          error = failure instanceof Error ? failure : new Error(String(failure));
        } finally {
          await retained.close();
        }
        if (logRetention(root).compression !== LogCompression.None)
          for (const path of [worker.log, worker.log + ".stderr"]) {
            try {
              await compressLogFile(path, logRetention(root).compression);
            } catch (failure) {
              diagnostic(
                LogLevel.Warn,
                DiagnosticOperation.CILogCompression,
                DiagnosticOutcome.Preserved,
                { file: path },
                failure,
                "complete source preserved",
              );
            }
          }
        await worker.finish(error);
        writeDiagnosticText(
          `Finished CI target ${worker.id}; stdout: ${worker.log}; stderr: ${worker.log}.stderr${error ? `; ${describeError(error)}` : ""}`,
        );
      }
    }),
  );
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((outcome) => outcome.reason as unknown),
      "CI worker coordination failed after draining active jobs",
    );
}
