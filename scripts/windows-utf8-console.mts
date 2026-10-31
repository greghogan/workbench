import { createOwnedScratch } from "./owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { settleCleanup } from "./diagnostic-errors.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// MSVC redirects /showIncludes using the console code page. Give the build its own console:
// changing a caller's console would race other builds and alter the user's terminal settings.
const launch = String.raw`
$ErrorActionPreference = 'Stop'
$request = $env:WORKBENCH_NATIVE_CONSOLE_REQUEST | ConvertFrom-Json
function Record-Stage($stage) { [System.IO.File]::WriteAllText($request.stage, $stage) }
Record-Stage 'console setup'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkbenchConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AllocConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCP(uint page);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleOutputCP(uint page);
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int stream);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetStdHandle(int stream, IntPtr handle);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$handles = @(-10, -11, -12) | ForEach-Object { [WorkbenchConsole]::GetStdHandle($_) }
Record-Stage 'console detach'
[void][WorkbenchConsole]::FreeConsole()
Record-Stage 'console allocation'
if (-not [WorkbenchConsole]::AllocConsole()) { throw 'Cannot allocate the build console' }
try {
  Record-Stage 'console handles'
  [void][WorkbenchConsole]::ShowWindow([WorkbenchConsole]::GetConsoleWindow(), 0)
  for ($i = 0; $i -lt 3; $i++) {
    if (-not [WorkbenchConsole]::SetStdHandle(-10 - $i, $handles[$i])) { throw 'Cannot restore build output' }
  }
  if (-not [WorkbenchConsole]::SetConsoleCP(65001) -or -not [WorkbenchConsole]::SetConsoleOutputCP(65001)) {
    throw 'Cannot select UTF-8 compiler output'
  }
  Record-Stage 'console encoding'
  $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Remove-Item Env:WORKBENCH_NATIVE_CONSOLE_REQUEST
  $arguments = @($request.arguments)
  Record-Stage 'native command'
  $ErrorActionPreference = 'Continue'
  & $request.node @arguments
  $result = $LASTEXITCODE
  if ($null -eq $result) { $result = 1 }
  [System.IO.File]::WriteAllText($request.result, (ConvertTo-Json @{status = $result}))
} finally {
  [void][WorkbenchConsole]::FreeConsole()
}
exit $result
`;

/** Stream a native build through a private UTF-8 Windows console, including hidden CI processes. */
export async function runWindowsUtf8Console(args: string[], builds: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("A private Windows console requires Windows");
  const scratch = createOwnedScratch(builds, "utf8"),
    cancellation = processCancellation(),
    receipt = join(scratch.directory, "result.json"),
    stage = join(scratch.directory, "stage.txt");
  let failure: unknown;
  try {
    const outcome = await runOwnedChild(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(launch, "utf16le").toString("base64"),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEMP: scratch.directory,
          TMP: scratch.directory,
          WORKBENCH_NATIVE_UTF8_CONSOLE: "1",
          WORKBENCH_NATIVE_CONSOLE_REQUEST: JSON.stringify({
            node: process.execPath,
            arguments: args,
            result: receipt,
            stage,
          }),
        },
        signal: cancellation.signal,
        owner: scratch.owner,
      },
    );
    failure = processFailure("UTF-8 native build", outcome);
    if (!failure) {
      if (!existsSync(receipt))
        throw new Error(
          `Build console ended before command completion (last stage: ${existsSync(stage) ? readFileSync(stage, "utf8").slice(0, 128) : "not started"})`,
        );
      const result = JSON.parse(readFileSync(receipt, "utf8")) as { status?: unknown };
      if (
        typeof result.status !== "number" ||
        !Number.isInteger(result.status) ||
        result.status < 0 ||
        result.status > 0xffffffff
      )
        throw new Error("Invalid native build exit status");
      if (result.status !== 0) throw new Error(`Native build failed (status=${String(result.status)})`);
    }
  } catch (error) {
    failure = error;
  }
  await settleCleanup([cancellation.close, scratch.release], failure);
}
