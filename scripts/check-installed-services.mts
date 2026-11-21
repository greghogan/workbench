import { dirname } from "node:path";
import { processCancellation, runOwnedChild } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { serviceCandidate } from "./service-check-inputs.mts";

const cancellation = processCancellation();
try {
  if (process.env.WORKBENCH_EXTENDED_DISPOSABLE_HOST !== "1")
    throw new Error("Use a disposable native host and set WORKBENCH_EXTENDED_DISPOSABLE_HOST=1");
  const environment = { ...process.env };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  const candidate = await serviceCandidate(cancellation.signal);
  const artifacts = dirname(candidate.path);
  const linux = ["user", "system"].map((scope) => ["bash", "scripts/check-linux-service.sh", scope, artifacts]);
  const macos = ["check-macos-service.sh", "check-macos-system-service.sh"].map((script) => [
    "bash",
    `scripts/${script}`,
    artifacts,
  ]);
  const windows = [
    ["-ResumeWorker", "-IdleWorkers", "-Handoff"],
    ["-PrivateService"],
    ["-Recovery"],
    ["-DesktopTask"],
  ].map((flags) => [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/check-windows-service.ps1",
    "-Node",
    process.execPath,
    "-Archive",
    candidate.path,
    "-Digest",
    candidate.sha256,
    ...flags,
  ]);
  const commands = { linux, darwin: macos, win32: windows };
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error("Installed service checks are available for Linux, macOS, and Windows");
  for (const [executable, ...args] of commands[platform]) {
    if (!executable) throw new Error("Missing service-check executable");
    cancellation.signal.throwIfAborted();
    const result = await runOwnedChild(executable, args, {
      cwd: process.cwd(),
      env: environment,
      signal: cancellation.signal,
      stopDescendantsOnExit: true,
    });
    const failure = processFailure("Installed service check", result);
    if (failure) throw failure;
  }
} finally {
  cancellation.close();
}
