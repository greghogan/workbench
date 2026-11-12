// Generated from windows-utf8-console.mts; edit the TypeScript source.
import { createOwnedScratch } from "./owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { settleCleanup } from "../diagnostics/diagnostic-errors.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsExecutableArgument } from "./windows-arguments.mjs";
const launch = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
  Remove-Item Env:WORKBENCH_NATIVE_CONSOLE_REQUEST
  Record-Stage 'native command'
  # PowerShell's native-command processor queries its old console handles after detachment.
  # Start directly through .NET, retaining the private console and original output pipes.
  $child = [System.Diagnostics.Process]::new()
  try {
    $child.StartInfo.FileName = $request.node
    $child.StartInfo.Arguments = $request.commandLine
    $child.StartInfo.UseShellExecute = $false
    $child.StartInfo.CreateNoWindow = $false
    if (-not $child.Start()) { throw 'Cannot start the native build' }
    $child.WaitForExit()
    $result = $child.ExitCode
    [System.IO.File]::WriteAllText($request.result, (ConvertTo-Json @{status = $result}))
  } finally {
    $child.Dispose()
  }
} finally {
  [void][WorkbenchConsole]::FreeConsole()
}
exit $result
`;
async function runWindowsUtf8Console(args, builds, cwd = process.cwd()) {
  if (process.platform !== "win32") throw new Error("A private Windows console requires Windows");
  const scratch = createOwnedScratch(builds, "utf8"), cancellation = processCancellation(), receipt = join(scratch.directory, "result.json"), stage = join(scratch.directory, "stage.txt");
  let failure;
  try {
    const outcome = await runOwnedChild(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(launch, "utf16le").toString("base64")
      ],
      {
        cwd,
        env: {
          ...process.env,
          TEMP: scratch.directory,
          TMP: scratch.directory,
          WORKBENCH_NATIVE_UTF8_CONSOLE: "1",
          WORKBENCH_NATIVE_CONSOLE_REQUEST: JSON.stringify({
            node: process.execPath,
            commandLine: args.map(windowsExecutableArgument).join(" "),
            result: receipt,
            stage
          })
        },
        signal: cancellation.signal,
        owner: scratch.owner
      }
    );
    cancellation.signal.throwIfAborted();
    failure = processFailure("UTF-8 native build", outcome);
    if (!failure) {
      if (!existsSync(receipt))
        throw new Error(
          `Build console ended before command completion (last stage: ${existsSync(stage) ? readFileSync(stage, "utf8").slice(0, 128) : "not started"})`
        );
      const result = JSON.parse(readFileSync(receipt, "utf8"));
      if (typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < -2147483648 || result.status > 4294967295)
        throw new Error("Invalid native build exit status");
      if (result.status !== 0) throw new Error(`Native build failed (status=${String(result.status)})`);
    }
  } catch (error) {
    failure = error;
  }
  await settleCleanup([cancellation.close, scratch.release], failure);
}
export {
  runWindowsUtf8Console
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIndpbmRvd3MtdXRmOC1jb25zb2xlLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVPd25lZFNjcmF0Y2ggfSBmcm9tIFwiLi9vd25lZC1zY3JhdGNoLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0NhbmNlbGxhdGlvbiwgcnVuT3duZWRDaGlsZCB9IGZyb20gXCIuL293bmVkLWNoaWxkLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZhaWx1cmUgfSBmcm9tIFwiLi9wcm9jZXNzLW91dGNvbWUubWpzXCI7XG5pbXBvcnQgeyBzZXR0bGVDbGVhbnVwIH0gZnJvbSBcIi4uL2RpYWdub3N0aWNzL2RpYWdub3N0aWMtZXJyb3JzLm1qc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB3aW5kb3dzRXhlY3V0YWJsZUFyZ3VtZW50IH0gZnJvbSBcIi4vd2luZG93cy1hcmd1bWVudHMubWpzXCI7XG5cbi8vIE1TVkMgcmVkaXJlY3RzIC9zaG93SW5jbHVkZXMgdXNpbmcgdGhlIGNvbnNvbGUgY29kZSBwYWdlLiBHaXZlIHRoZSBidWlsZCBpdHMgb3duIGNvbnNvbGU6XG4vLyBjaGFuZ2luZyBhIGNhbGxlcidzIGNvbnNvbGUgd291bGQgcmFjZSBvdGhlciBidWlsZHMgYW5kIGFsdGVyIHRoZSB1c2VyJ3MgdGVybWluYWwgc2V0dGluZ3MuXG5jb25zdCBsYXVuY2ggPSBTdHJpbmcucmF3YFxuJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJ1xuJFByb2dyZXNzUHJlZmVyZW5jZSA9ICdTaWxlbnRseUNvbnRpbnVlJ1xuJHJlcXVlc3QgPSAkZW52OldPUktCRU5DSF9OQVRJVkVfQ09OU09MRV9SRVFVRVNUIHwgQ29udmVydEZyb20tSnNvblxuZnVuY3Rpb24gUmVjb3JkLVN0YWdlKCRzdGFnZSkgeyBbU3lzdGVtLklPLkZpbGVdOjpXcml0ZUFsbFRleHQoJHJlcXVlc3Quc3RhZ2UsICRzdGFnZSkgfVxuUmVjb3JkLVN0YWdlICdjb25zb2xlIHNldHVwJ1xuQWRkLVR5cGUgLVR5cGVEZWZpbml0aW9uIEAnXG51c2luZyBTeXN0ZW07XG51c2luZyBTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXM7XG5wdWJsaWMgc3RhdGljIGNsYXNzIFdvcmtiZW5jaENvbnNvbGUge1xuICBbRGxsSW1wb3J0KFwia2VybmVsMzIuZGxsXCIsIFNldExhc3RFcnJvciA9IHRydWUpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIEZyZWVDb25zb2xlKCk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgQWxsb2NDb25zb2xlKCk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0Q29uc29sZUNQKHVpbnQgcGFnZSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0Q29uc29sZU91dHB1dENQKHVpbnQgcGFnZSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIEludFB0ciBHZXRTdGRIYW5kbGUoaW50IHN0cmVhbSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0U3RkSGFuZGxlKGludCBzdHJlYW0sIEludFB0ciBoYW5kbGUpO1xuICBbRGxsSW1wb3J0KFwia2VybmVsMzIuZGxsXCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBJbnRQdHIgR2V0Q29uc29sZVdpbmRvdygpO1xuICBbRGxsSW1wb3J0KFwidXNlcjMyLmRsbFwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTaG93V2luZG93KEludFB0ciB3aW5kb3csIGludCBjb21tYW5kKTtcbn1cbidAXG4kaGFuZGxlcyA9IEAoLTEwLCAtMTEsIC0xMikgfCBGb3JFYWNoLU9iamVjdCB7IFtXb3JrYmVuY2hDb25zb2xlXTo6R2V0U3RkSGFuZGxlKCRfKSB9XG5SZWNvcmQtU3RhZ2UgJ2NvbnNvbGUgZGV0YWNoJ1xuW3ZvaWRdW1dvcmtiZW5jaENvbnNvbGVdOjpGcmVlQ29uc29sZSgpXG5SZWNvcmQtU3RhZ2UgJ2NvbnNvbGUgYWxsb2NhdGlvbidcbmlmICgtbm90IFtXb3JrYmVuY2hDb25zb2xlXTo6QWxsb2NDb25zb2xlKCkpIHsgdGhyb3cgJ0Nhbm5vdCBhbGxvY2F0ZSB0aGUgYnVpbGQgY29uc29sZScgfVxudHJ5IHtcbiAgUmVjb3JkLVN0YWdlICdjb25zb2xlIGhhbmRsZXMnXG4gIFt2b2lkXVtXb3JrYmVuY2hDb25zb2xlXTo6U2hvd1dpbmRvdyhbV29ya2JlbmNoQ29uc29sZV06OkdldENvbnNvbGVXaW5kb3coKSwgMClcbiAgZm9yICgkaSA9IDA7ICRpIC1sdCAzOyAkaSsrKSB7XG4gICAgaWYgKC1ub3QgW1dvcmtiZW5jaENvbnNvbGVdOjpTZXRTdGRIYW5kbGUoLTEwIC0gJGksICRoYW5kbGVzWyRpXSkpIHsgdGhyb3cgJ0Nhbm5vdCByZXN0b3JlIGJ1aWxkIG91dHB1dCcgfVxuICB9XG4gIGlmICgtbm90IFtXb3JrYmVuY2hDb25zb2xlXTo6U2V0Q29uc29sZUNQKDY1MDAxKSAtb3IgLW5vdCBbV29ya2JlbmNoQ29uc29sZV06OlNldENvbnNvbGVPdXRwdXRDUCg2NTAwMSkpIHtcbiAgICB0aHJvdyAnQ2Fubm90IHNlbGVjdCBVVEYtOCBjb21waWxlciBvdXRwdXQnXG4gIH1cbiAgUmVtb3ZlLUl0ZW0gRW52OldPUktCRU5DSF9OQVRJVkVfQ09OU09MRV9SRVFVRVNUXG4gIFJlY29yZC1TdGFnZSAnbmF0aXZlIGNvbW1hbmQnXG4gICMgUG93ZXJTaGVsbCdzIG5hdGl2ZS1jb21tYW5kIHByb2Nlc3NvciBxdWVyaWVzIGl0cyBvbGQgY29uc29sZSBoYW5kbGVzIGFmdGVyIGRldGFjaG1lbnQuXG4gICMgU3RhcnQgZGlyZWN0bHkgdGhyb3VnaCAuTkVULCByZXRhaW5pbmcgdGhlIHByaXZhdGUgY29uc29sZSBhbmQgb3JpZ2luYWwgb3V0cHV0IHBpcGVzLlxuICAkY2hpbGQgPSBbU3lzdGVtLkRpYWdub3N0aWNzLlByb2Nlc3NdOjpuZXcoKVxuICB0cnkge1xuICAgICRjaGlsZC5TdGFydEluZm8uRmlsZU5hbWUgPSAkcmVxdWVzdC5ub2RlXG4gICAgJGNoaWxkLlN0YXJ0SW5mby5Bcmd1bWVudHMgPSAkcmVxdWVzdC5jb21tYW5kTGluZVxuICAgICRjaGlsZC5TdGFydEluZm8uVXNlU2hlbGxFeGVjdXRlID0gJGZhbHNlXG4gICAgJGNoaWxkLlN0YXJ0SW5mby5DcmVhdGVOb1dpbmRvdyA9ICRmYWxzZVxuICAgIGlmICgtbm90ICRjaGlsZC5TdGFydCgpKSB7IHRocm93ICdDYW5ub3Qgc3RhcnQgdGhlIG5hdGl2ZSBidWlsZCcgfVxuICAgICRjaGlsZC5XYWl0Rm9yRXhpdCgpXG4gICAgJHJlc3VsdCA9ICRjaGlsZC5FeGl0Q29kZVxuICAgIFtTeXN0ZW0uSU8uRmlsZV06OldyaXRlQWxsVGV4dCgkcmVxdWVzdC5yZXN1bHQsIChDb252ZXJ0VG8tSnNvbiBAe3N0YXR1cyA9ICRyZXN1bHR9KSlcbiAgfSBmaW5hbGx5IHtcbiAgICAkY2hpbGQuRGlzcG9zZSgpXG4gIH1cbn0gZmluYWxseSB7XG4gIFt2b2lkXVtXb3JrYmVuY2hDb25zb2xlXTo6RnJlZUNvbnNvbGUoKVxufVxuZXhpdCAkcmVzdWx0XG5gO1xuXG4vKiogU3RyZWFtIGEgbmF0aXZlIGJ1aWxkIHRocm91Z2ggYSBwcml2YXRlIFVURi04IFdpbmRvd3MgY29uc29sZSwgaW5jbHVkaW5nIGhpZGRlbiBDSSBwcm9jZXNzZXMuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuV2luZG93c1V0ZjhDb25zb2xlKGFyZ3M6IHN0cmluZ1tdLCBidWlsZHM6IHN0cmluZywgY3dkID0gcHJvY2Vzcy5jd2QoKSk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiKSB0aHJvdyBuZXcgRXJyb3IoXCJBIHByaXZhdGUgV2luZG93cyBjb25zb2xlIHJlcXVpcmVzIFdpbmRvd3NcIik7XG4gIGNvbnN0IHNjcmF0Y2ggPSBjcmVhdGVPd25lZFNjcmF0Y2goYnVpbGRzLCBcInV0ZjhcIiksXG4gICAgY2FuY2VsbGF0aW9uID0gcHJvY2Vzc0NhbmNlbGxhdGlvbigpLFxuICAgIHJlY2VpcHQgPSBqb2luKHNjcmF0Y2guZGlyZWN0b3J5LCBcInJlc3VsdC5qc29uXCIpLFxuICAgIHN0YWdlID0gam9pbihzY3JhdGNoLmRpcmVjdG9yeSwgXCJzdGFnZS50eHRcIik7XG4gIGxldCBmYWlsdXJlOiB1bmtub3duO1xuICB0cnkge1xuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBydW5Pd25lZENoaWxkKFxuICAgICAgXCJwb3dlcnNoZWxsLmV4ZVwiLFxuICAgICAgW1xuICAgICAgICBcIi1Ob0xvZ29cIixcbiAgICAgICAgXCItTm9Qcm9maWxlXCIsXG4gICAgICAgIFwiLU5vbkludGVyYWN0aXZlXCIsXG4gICAgICAgIFwiLUVuY29kZWRDb21tYW5kXCIsXG4gICAgICAgIEJ1ZmZlci5mcm9tKGxhdW5jaCwgXCJ1dGYxNmxlXCIpLnRvU3RyaW5nKFwiYmFzZTY0XCIpLFxuICAgICAgXSxcbiAgICAgIHtcbiAgICAgICAgY3dkLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBURU1QOiBzY3JhdGNoLmRpcmVjdG9yeSxcbiAgICAgICAgICBUTVA6IHNjcmF0Y2guZGlyZWN0b3J5LFxuICAgICAgICAgIFdPUktCRU5DSF9OQVRJVkVfVVRGOF9DT05TT0xFOiBcIjFcIixcbiAgICAgICAgICBXT1JLQkVOQ0hfTkFUSVZFX0NPTlNPTEVfUkVRVUVTVDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgbm9kZTogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICAgIGNvbW1hbmRMaW5lOiBhcmdzLm1hcCh3aW5kb3dzRXhlY3V0YWJsZUFyZ3VtZW50KS5qb2luKFwiIFwiKSxcbiAgICAgICAgICAgIHJlc3VsdDogcmVjZWlwdCxcbiAgICAgICAgICAgIHN0YWdlLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9LFxuICAgICAgICBzaWduYWw6IGNhbmNlbGxhdGlvbi5zaWduYWwsXG4gICAgICAgIG93bmVyOiBzY3JhdGNoLm93bmVyLFxuICAgICAgfSxcbiAgICApO1xuICAgIGNhbmNlbGxhdGlvbi5zaWduYWwudGhyb3dJZkFib3J0ZWQoKTtcbiAgICBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoXCJVVEYtOCBuYXRpdmUgYnVpbGRcIiwgb3V0Y29tZSk7XG4gICAgaWYgKCFmYWlsdXJlKSB7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMocmVjZWlwdCkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQnVpbGQgY29uc29sZSBlbmRlZCBiZWZvcmUgY29tbWFuZCBjb21wbGV0aW9uIChsYXN0IHN0YWdlOiAke2V4aXN0c1N5bmMoc3RhZ2UpID8gcmVhZEZpbGVTeW5jKHN0YWdlLCBcInV0ZjhcIikuc2xpY2UoMCwgMTI4KSA6IFwibm90IHN0YXJ0ZWRcIn0pYCxcbiAgICAgICAgKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJlY2VpcHQsIFwidXRmOFwiKSkgYXMgeyBzdGF0dXM/OiB1bmtub3duIH07XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiByZXN1bHQuc3RhdHVzICE9PSBcIm51bWJlclwiIHx8XG4gICAgICAgICFOdW1iZXIuaXNJbnRlZ2VyKHJlc3VsdC5zdGF0dXMpIHx8XG4gICAgICAgIHJlc3VsdC5zdGF0dXMgPCAtMHg4MDAwMDAwMCB8fFxuICAgICAgICByZXN1bHQuc3RhdHVzID4gMHhmZmZmZmZmZlxuICAgICAgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG5hdGl2ZSBidWlsZCBleGl0IHN0YXR1c1wiKTtcbiAgICAgIGlmIChyZXN1bHQuc3RhdHVzICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYE5hdGl2ZSBidWlsZCBmYWlsZWQgKHN0YXR1cz0ke1N0cmluZyhyZXN1bHQuc3RhdHVzKX0pYCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGZhaWx1cmUgPSBlcnJvcjtcbiAgfVxuICBhd2FpdCBzZXR0bGVDbGVhbnVwKFtjYW5jZWxsYXRpb24uY2xvc2UsIHNjcmF0Y2gucmVsZWFzZV0sIGZhaWx1cmUpO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxxQkFBcUIscUJBQXFCO0FBQ25ELFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsWUFBWSxvQkFBb0I7QUFDekMsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsaUNBQWlDO0FBSTFDLE1BQU0sU0FBUyxPQUFPO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUEwRHRCLGVBQXNCLHNCQUFzQixNQUFnQixRQUFnQixNQUFNLFFBQVEsSUFBSSxHQUFrQjtBQUM5RyxNQUFJLFFBQVEsYUFBYSxRQUFTLE9BQU0sSUFBSSxNQUFNLDRDQUE0QztBQUM5RixRQUFNLFVBQVUsbUJBQW1CLFFBQVEsTUFBTSxHQUMvQyxlQUFlLG9CQUFvQixHQUNuQyxVQUFVLEtBQUssUUFBUSxXQUFXLGFBQWEsR0FDL0MsUUFBUSxLQUFLLFFBQVEsV0FBVyxXQUFXO0FBQzdDLE1BQUk7QUFDSixNQUFJO0FBQ0YsVUFBTSxVQUFVLE1BQU07QUFBQSxNQUNwQjtBQUFBLE1BQ0E7QUFBQSxRQUNFO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxPQUFPLEtBQUssUUFBUSxTQUFTLEVBQUUsU0FBUyxRQUFRO0FBQUEsTUFDbEQ7QUFBQSxNQUNBO0FBQUEsUUFDRTtBQUFBLFFBQ0EsS0FBSztBQUFBLFVBQ0gsR0FBRyxRQUFRO0FBQUEsVUFDWCxNQUFNLFFBQVE7QUFBQSxVQUNkLEtBQUssUUFBUTtBQUFBLFVBQ2IsK0JBQStCO0FBQUEsVUFDL0Isa0NBQWtDLEtBQUssVUFBVTtBQUFBLFlBQy9DLE1BQU0sUUFBUTtBQUFBLFlBQ2QsYUFBYSxLQUFLLElBQUkseUJBQXlCLEVBQUUsS0FBSyxHQUFHO0FBQUEsWUFDekQsUUFBUTtBQUFBLFlBQ1I7QUFBQSxVQUNGLENBQUM7QUFBQSxRQUNIO0FBQUEsUUFDQSxRQUFRLGFBQWE7QUFBQSxRQUNyQixPQUFPLFFBQVE7QUFBQSxNQUNqQjtBQUFBLElBQ0Y7QUFDQSxpQkFBYSxPQUFPLGVBQWU7QUFDbkMsY0FBVSxlQUFlLHNCQUFzQixPQUFPO0FBQ3RELFFBQUksQ0FBQyxTQUFTO0FBQ1osVUFBSSxDQUFDLFdBQVcsT0FBTztBQUNyQixjQUFNLElBQUk7QUFBQSxVQUNSLDhEQUE4RCxXQUFXLEtBQUssSUFBSSxhQUFhLE9BQU8sTUFBTSxFQUFFLE1BQU0sR0FBRyxHQUFHLElBQUksYUFBYTtBQUFBLFFBQzdJO0FBQ0YsWUFBTSxTQUFTLEtBQUssTUFBTSxhQUFhLFNBQVMsTUFBTSxDQUFDO0FBQ3ZELFVBQ0UsT0FBTyxPQUFPLFdBQVcsWUFDekIsQ0FBQyxPQUFPLFVBQVUsT0FBTyxNQUFNLEtBQy9CLE9BQU8sU0FBUyxlQUNoQixPQUFPLFNBQVM7QUFFaEIsY0FBTSxJQUFJLE1BQU0sa0NBQWtDO0FBQ3BELFVBQUksT0FBTyxXQUFXLEVBQUcsT0FBTSxJQUFJLE1BQU0sK0JBQStCLE9BQU8sT0FBTyxNQUFNLENBQUMsR0FBRztBQUFBLElBQ2xHO0FBQUEsRUFDRixTQUFTLE9BQU87QUFDZCxjQUFVO0FBQUEsRUFDWjtBQUNBLFFBQU0sY0FBYyxDQUFDLGFBQWEsT0FBTyxRQUFRLE9BQU8sR0FBRyxPQUFPO0FBQ3BFOyIsIm5hbWVzIjpbXSwiZmlsZSI6ImFwcC9zcmMvY29yZS9ydW50aW1lL3dpbmRvd3MtdXRmOC1jb25zb2xlLm1qcyJ9
