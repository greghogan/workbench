import { createOwnedScratch } from "./owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { settleCleanup } from "./diagnostic-errors.mjs";

// MSVC redirects /showIncludes using the console code page. Give the build its own console:
// changing a caller's console would race other builds and alter the user's terminal settings.
const launch = String.raw`
$ErrorActionPreference = 'Stop'
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
[void][WorkbenchConsole]::FreeConsole()
if (-not [WorkbenchConsole]::AllocConsole()) { throw 'Cannot allocate the build console' }
try {
  [void][WorkbenchConsole]::ShowWindow([WorkbenchConsole]::GetConsoleWindow(), 0)
  for ($i = 0; $i -lt 3; $i++) {
    if (-not [WorkbenchConsole]::SetStdHandle(-10 - $i, $handles[$i])) { throw 'Cannot restore build output' }
  }
  if (-not [WorkbenchConsole]::SetConsoleCP(65001) -or -not [WorkbenchConsole]::SetConsoleOutputCP(65001)) {
    throw 'Cannot select UTF-8 compiler output'
  }
  $OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $request = $env:WORKBENCH_NATIVE_CONSOLE_REQUEST | ConvertFrom-Json
  Remove-Item Env:WORKBENCH_NATIVE_CONSOLE_REQUEST
  $arguments = @($request.arguments)
  $ErrorActionPreference = 'Continue'
  & $request.node @arguments
  $result = $LASTEXITCODE
  if ($null -eq $result) { $result = 1 }
} finally {
  [void][WorkbenchConsole]::FreeConsole()
}
exit $result
`;

/** Stream a native build through a private UTF-8 Windows console, including hidden CI processes. */
export async function runWindowsUtf8Console(args: string[], builds: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("A private Windows console requires Windows");
  const scratch = createOwnedScratch(builds, "utf8"),
    cancellation = processCancellation();
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
          WORKBENCH_NATIVE_CONSOLE_REQUEST: JSON.stringify({ node: process.execPath, arguments: args }),
        },
        signal: cancellation.signal,
        owner: scratch.owner,
      },
    );
    failure = processFailure("UTF-8 native build", outcome);
  } catch (error) {
    failure = error;
  }
  await settleCleanup([cancellation.close, scratch.release], failure);
}
