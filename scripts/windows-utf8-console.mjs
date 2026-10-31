// Generated from windows-utf8-console.mts; edit the TypeScript source.
import { createOwnedScratch } from "./owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { settleCleanup } from "./diagnostic-errors.mjs";
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
async function runWindowsUtf8Console(args, builds) {
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
        cwd: process.cwd(),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIndpbmRvd3MtdXRmOC1jb25zb2xlLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVPd25lZFNjcmF0Y2ggfSBmcm9tIFwiLi9vd25lZC1zY3JhdGNoLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0NhbmNlbGxhdGlvbiwgcnVuT3duZWRDaGlsZCB9IGZyb20gXCIuL293bmVkLWNoaWxkLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZhaWx1cmUgfSBmcm9tIFwiLi9wcm9jZXNzLW91dGNvbWUubWpzXCI7XG5pbXBvcnQgeyBzZXR0bGVDbGVhbnVwIH0gZnJvbSBcIi4vZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHdpbmRvd3NFeGVjdXRhYmxlQXJndW1lbnQgfSBmcm9tIFwiLi93aW5kb3dzLWFyZ3VtZW50cy5tanNcIjtcblxuLy8gTVNWQyByZWRpcmVjdHMgL3Nob3dJbmNsdWRlcyB1c2luZyB0aGUgY29uc29sZSBjb2RlIHBhZ2UuIEdpdmUgdGhlIGJ1aWxkIGl0cyBvd24gY29uc29sZTpcbi8vIGNoYW5naW5nIGEgY2FsbGVyJ3MgY29uc29sZSB3b3VsZCByYWNlIG90aGVyIGJ1aWxkcyBhbmQgYWx0ZXIgdGhlIHVzZXIncyB0ZXJtaW5hbCBzZXR0aW5ncy5cbmNvbnN0IGxhdW5jaCA9IFN0cmluZy5yYXdgXG4kRXJyb3JBY3Rpb25QcmVmZXJlbmNlID0gJ1N0b3AnXG4kUHJvZ3Jlc3NQcmVmZXJlbmNlID0gJ1NpbGVudGx5Q29udGludWUnXG4kcmVxdWVzdCA9ICRlbnY6V09SS0JFTkNIX05BVElWRV9DT05TT0xFX1JFUVVFU1QgfCBDb252ZXJ0RnJvbS1Kc29uXG5mdW5jdGlvbiBSZWNvcmQtU3RhZ2UoJHN0YWdlKSB7IFtTeXN0ZW0uSU8uRmlsZV06OldyaXRlQWxsVGV4dCgkcmVxdWVzdC5zdGFnZSwgJHN0YWdlKSB9XG5SZWNvcmQtU3RhZ2UgJ2NvbnNvbGUgc2V0dXAnXG5BZGQtVHlwZSAtVHlwZURlZmluaXRpb24gQCdcbnVzaW5nIFN5c3RlbTtcbnVzaW5nIFN5c3RlbS5SdW50aW1lLkludGVyb3BTZXJ2aWNlcztcbnB1YmxpYyBzdGF0aWMgY2xhc3MgV29ya2JlbmNoQ29uc29sZSB7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgRnJlZUNvbnNvbGUoKTtcbiAgW0RsbEltcG9ydChcImtlcm5lbDMyLmRsbFwiLCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBBbGxvY0NvbnNvbGUoKTtcbiAgW0RsbEltcG9ydChcImtlcm5lbDMyLmRsbFwiLCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTZXRDb25zb2xlQ1AodWludCBwYWdlKTtcbiAgW0RsbEltcG9ydChcImtlcm5lbDMyLmRsbFwiLCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTZXRDb25zb2xlT3V0cHV0Q1AodWludCBwYWdlKTtcbiAgW0RsbEltcG9ydChcImtlcm5lbDMyLmRsbFwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gSW50UHRyIEdldFN0ZEhhbmRsZShpbnQgc3RyZWFtKTtcbiAgW0RsbEltcG9ydChcImtlcm5lbDMyLmRsbFwiLCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTZXRTdGRIYW5kbGUoaW50IHN0cmVhbSwgSW50UHRyIGhhbmRsZSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIEludFB0ciBHZXRDb25zb2xlV2luZG93KCk7XG4gIFtEbGxJbXBvcnQoXCJ1c2VyMzIuZGxsXCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIFNob3dXaW5kb3coSW50UHRyIHdpbmRvdywgaW50IGNvbW1hbmQpO1xufVxuJ0BcbiRoYW5kbGVzID0gQCgtMTAsIC0xMSwgLTEyKSB8IEZvckVhY2gtT2JqZWN0IHsgW1dvcmtiZW5jaENvbnNvbGVdOjpHZXRTdGRIYW5kbGUoJF8pIH1cblJlY29yZC1TdGFnZSAnY29uc29sZSBkZXRhY2gnXG5bdm9pZF1bV29ya2JlbmNoQ29uc29sZV06OkZyZWVDb25zb2xlKClcblJlY29yZC1TdGFnZSAnY29uc29sZSBhbGxvY2F0aW9uJ1xuaWYgKC1ub3QgW1dvcmtiZW5jaENvbnNvbGVdOjpBbGxvY0NvbnNvbGUoKSkgeyB0aHJvdyAnQ2Fubm90IGFsbG9jYXRlIHRoZSBidWlsZCBjb25zb2xlJyB9XG50cnkge1xuICBSZWNvcmQtU3RhZ2UgJ2NvbnNvbGUgaGFuZGxlcydcbiAgW3ZvaWRdW1dvcmtiZW5jaENvbnNvbGVdOjpTaG93V2luZG93KFtXb3JrYmVuY2hDb25zb2xlXTo6R2V0Q29uc29sZVdpbmRvdygpLCAwKVxuICBmb3IgKCRpID0gMDsgJGkgLWx0IDM7ICRpKyspIHtcbiAgICBpZiAoLW5vdCBbV29ya2JlbmNoQ29uc29sZV06OlNldFN0ZEhhbmRsZSgtMTAgLSAkaSwgJGhhbmRsZXNbJGldKSkgeyB0aHJvdyAnQ2Fubm90IHJlc3RvcmUgYnVpbGQgb3V0cHV0JyB9XG4gIH1cbiAgaWYgKC1ub3QgW1dvcmtiZW5jaENvbnNvbGVdOjpTZXRDb25zb2xlQ1AoNjUwMDEpIC1vciAtbm90IFtXb3JrYmVuY2hDb25zb2xlXTo6U2V0Q29uc29sZU91dHB1dENQKDY1MDAxKSkge1xuICAgIHRocm93ICdDYW5ub3Qgc2VsZWN0IFVURi04IGNvbXBpbGVyIG91dHB1dCdcbiAgfVxuICBSZW1vdmUtSXRlbSBFbnY6V09SS0JFTkNIX05BVElWRV9DT05TT0xFX1JFUVVFU1RcbiAgUmVjb3JkLVN0YWdlICduYXRpdmUgY29tbWFuZCdcbiAgIyBQb3dlclNoZWxsJ3MgbmF0aXZlLWNvbW1hbmQgcHJvY2Vzc29yIHF1ZXJpZXMgaXRzIG9sZCBjb25zb2xlIGhhbmRsZXMgYWZ0ZXIgZGV0YWNobWVudC5cbiAgIyBTdGFydCBkaXJlY3RseSB0aHJvdWdoIC5ORVQsIHJldGFpbmluZyB0aGUgcHJpdmF0ZSBjb25zb2xlIGFuZCBvcmlnaW5hbCBvdXRwdXQgcGlwZXMuXG4gICRjaGlsZCA9IFtTeXN0ZW0uRGlhZ25vc3RpY3MuUHJvY2Vzc106Om5ldygpXG4gIHRyeSB7XG4gICAgJGNoaWxkLlN0YXJ0SW5mby5GaWxlTmFtZSA9ICRyZXF1ZXN0Lm5vZGVcbiAgICAkY2hpbGQuU3RhcnRJbmZvLkFyZ3VtZW50cyA9ICRyZXF1ZXN0LmNvbW1hbmRMaW5lXG4gICAgJGNoaWxkLlN0YXJ0SW5mby5Vc2VTaGVsbEV4ZWN1dGUgPSAkZmFsc2VcbiAgICAkY2hpbGQuU3RhcnRJbmZvLkNyZWF0ZU5vV2luZG93ID0gJGZhbHNlXG4gICAgaWYgKC1ub3QgJGNoaWxkLlN0YXJ0KCkpIHsgdGhyb3cgJ0Nhbm5vdCBzdGFydCB0aGUgbmF0aXZlIGJ1aWxkJyB9XG4gICAgJGNoaWxkLldhaXRGb3JFeGl0KClcbiAgICAkcmVzdWx0ID0gJGNoaWxkLkV4aXRDb2RlXG4gICAgW1N5c3RlbS5JTy5GaWxlXTo6V3JpdGVBbGxUZXh0KCRyZXF1ZXN0LnJlc3VsdCwgKENvbnZlcnRUby1Kc29uIEB7c3RhdHVzID0gJHJlc3VsdH0pKVxuICB9IGZpbmFsbHkge1xuICAgICRjaGlsZC5EaXNwb3NlKClcbiAgfVxufSBmaW5hbGx5IHtcbiAgW3ZvaWRdW1dvcmtiZW5jaENvbnNvbGVdOjpGcmVlQ29uc29sZSgpXG59XG5leGl0ICRyZXN1bHRcbmA7XG5cbi8qKiBTdHJlYW0gYSBuYXRpdmUgYnVpbGQgdGhyb3VnaCBhIHByaXZhdGUgVVRGLTggV2luZG93cyBjb25zb2xlLCBpbmNsdWRpbmcgaGlkZGVuIENJIHByb2Nlc3Nlcy4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5XaW5kb3dzVXRmOENvbnNvbGUoYXJnczogc3RyaW5nW10sIGJ1aWxkczogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIpIHRocm93IG5ldyBFcnJvcihcIkEgcHJpdmF0ZSBXaW5kb3dzIGNvbnNvbGUgcmVxdWlyZXMgV2luZG93c1wiKTtcbiAgY29uc3Qgc2NyYXRjaCA9IGNyZWF0ZU93bmVkU2NyYXRjaChidWlsZHMsIFwidXRmOFwiKSxcbiAgICBjYW5jZWxsYXRpb24gPSBwcm9jZXNzQ2FuY2VsbGF0aW9uKCksXG4gICAgcmVjZWlwdCA9IGpvaW4oc2NyYXRjaC5kaXJlY3RvcnksIFwicmVzdWx0Lmpzb25cIiksXG4gICAgc3RhZ2UgPSBqb2luKHNjcmF0Y2guZGlyZWN0b3J5LCBcInN0YWdlLnR4dFwiKTtcbiAgbGV0IGZhaWx1cmU6IHVua25vd247XG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoXG4gICAgICBcInBvd2Vyc2hlbGwuZXhlXCIsXG4gICAgICBbXG4gICAgICAgIFwiLU5vTG9nb1wiLFxuICAgICAgICBcIi1Ob1Byb2ZpbGVcIixcbiAgICAgICAgXCItTm9uSW50ZXJhY3RpdmVcIixcbiAgICAgICAgXCItRW5jb2RlZENvbW1hbmRcIixcbiAgICAgICAgQnVmZmVyLmZyb20obGF1bmNoLCBcInV0ZjE2bGVcIikudG9TdHJpbmcoXCJiYXNlNjRcIiksXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFRFTVA6IHNjcmF0Y2guZGlyZWN0b3J5LFxuICAgICAgICAgIFRNUDogc2NyYXRjaC5kaXJlY3RvcnksXG4gICAgICAgICAgV09SS0JFTkNIX05BVElWRV9VVEY4X0NPTlNPTEU6IFwiMVwiLFxuICAgICAgICAgIFdPUktCRU5DSF9OQVRJVkVfQ09OU09MRV9SRVFVRVNUOiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICBub2RlOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAgICAgY29tbWFuZExpbmU6IGFyZ3MubWFwKHdpbmRvd3NFeGVjdXRhYmxlQXJndW1lbnQpLmpvaW4oXCIgXCIpLFxuICAgICAgICAgICAgcmVzdWx0OiByZWNlaXB0LFxuICAgICAgICAgICAgc3RhZ2UsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICAgIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCxcbiAgICAgICAgb3duZXI6IHNjcmF0Y2gub3duZXIsXG4gICAgICB9LFxuICAgICk7XG4gICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgIGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShcIlVURi04IG5hdGl2ZSBidWlsZFwiLCBvdXRjb21lKTtcbiAgICBpZiAoIWZhaWx1cmUpIHtcbiAgICAgIGlmICghZXhpc3RzU3luYyhyZWNlaXB0KSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBCdWlsZCBjb25zb2xlIGVuZGVkIGJlZm9yZSBjb21tYW5kIGNvbXBsZXRpb24gKGxhc3Qgc3RhZ2U6ICR7ZXhpc3RzU3luYyhzdGFnZSkgPyByZWFkRmlsZVN5bmMoc3RhZ2UsIFwidXRmOFwiKS5zbGljZSgwLCAxMjgpIDogXCJub3Qgc3RhcnRlZFwifSlgLFxuICAgICAgICApO1xuICAgICAgY29uc3QgcmVzdWx0ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVjZWlwdCwgXCJ1dGY4XCIpKSBhcyB7IHN0YXR1cz86IHVua25vd24gfTtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIHJlc3VsdC5zdGF0dXMgIT09IFwibnVtYmVyXCIgfHxcbiAgICAgICAgIU51bWJlci5pc0ludGVnZXIocmVzdWx0LnN0YXR1cykgfHxcbiAgICAgICAgcmVzdWx0LnN0YXR1cyA8IC0weDgwMDAwMDAwIHx8XG4gICAgICAgIHJlc3VsdC5zdGF0dXMgPiAweGZmZmZmZmZmXG4gICAgICApXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbmF0aXZlIGJ1aWxkIGV4aXQgc3RhdHVzXCIpO1xuICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgIT09IDApIHRocm93IG5ldyBFcnJvcihgTmF0aXZlIGJ1aWxkIGZhaWxlZCAoc3RhdHVzPSR7U3RyaW5nKHJlc3VsdC5zdGF0dXMpfSlgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZSA9IGVycm9yO1xuICB9XG4gIGF3YWl0IHNldHRsZUNsZWFudXAoW2NhbmNlbGxhdGlvbi5jbG9zZSwgc2NyYXRjaC5yZWxlYXNlXSwgZmFpbHVyZSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLHFCQUFxQixxQkFBcUI7QUFDbkQsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLFlBQVk7QUFDckIsU0FBUyxpQ0FBaUM7QUFJMUMsTUFBTSxTQUFTLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQTBEdEIsZUFBc0Isc0JBQXNCLE1BQWdCLFFBQStCO0FBQ3pGLE1BQUksUUFBUSxhQUFhLFFBQVMsT0FBTSxJQUFJLE1BQU0sNENBQTRDO0FBQzlGLFFBQU0sVUFBVSxtQkFBbUIsUUFBUSxNQUFNLEdBQy9DLGVBQWUsb0JBQW9CLEdBQ25DLFVBQVUsS0FBSyxRQUFRLFdBQVcsYUFBYSxHQUMvQyxRQUFRLEtBQUssUUFBUSxXQUFXLFdBQVc7QUFDN0MsTUFBSTtBQUNKLE1BQUk7QUFDRixVQUFNLFVBQVUsTUFBTTtBQUFBLE1BQ3BCO0FBQUEsTUFDQTtBQUFBLFFBQ0U7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLE9BQU8sS0FBSyxRQUFRLFNBQVMsRUFBRSxTQUFTLFFBQVE7QUFBQSxNQUNsRDtBQUFBLE1BQ0E7QUFBQSxRQUNFLEtBQUssUUFBUSxJQUFJO0FBQUEsUUFDakIsS0FBSztBQUFBLFVBQ0gsR0FBRyxRQUFRO0FBQUEsVUFDWCxNQUFNLFFBQVE7QUFBQSxVQUNkLEtBQUssUUFBUTtBQUFBLFVBQ2IsK0JBQStCO0FBQUEsVUFDL0Isa0NBQWtDLEtBQUssVUFBVTtBQUFBLFlBQy9DLE1BQU0sUUFBUTtBQUFBLFlBQ2QsYUFBYSxLQUFLLElBQUkseUJBQXlCLEVBQUUsS0FBSyxHQUFHO0FBQUEsWUFDekQsUUFBUTtBQUFBLFlBQ1I7QUFBQSxVQUNGLENBQUM7QUFBQSxRQUNIO0FBQUEsUUFDQSxRQUFRLGFBQWE7QUFBQSxRQUNyQixPQUFPLFFBQVE7QUFBQSxNQUNqQjtBQUFBLElBQ0Y7QUFDQSxpQkFBYSxPQUFPLGVBQWU7QUFDbkMsY0FBVSxlQUFlLHNCQUFzQixPQUFPO0FBQ3RELFFBQUksQ0FBQyxTQUFTO0FBQ1osVUFBSSxDQUFDLFdBQVcsT0FBTztBQUNyQixjQUFNLElBQUk7QUFBQSxVQUNSLDhEQUE4RCxXQUFXLEtBQUssSUFBSSxhQUFhLE9BQU8sTUFBTSxFQUFFLE1BQU0sR0FBRyxHQUFHLElBQUksYUFBYTtBQUFBLFFBQzdJO0FBQ0YsWUFBTSxTQUFTLEtBQUssTUFBTSxhQUFhLFNBQVMsTUFBTSxDQUFDO0FBQ3ZELFVBQ0UsT0FBTyxPQUFPLFdBQVcsWUFDekIsQ0FBQyxPQUFPLFVBQVUsT0FBTyxNQUFNLEtBQy9CLE9BQU8sU0FBUyxlQUNoQixPQUFPLFNBQVM7QUFFaEIsY0FBTSxJQUFJLE1BQU0sa0NBQWtDO0FBQ3BELFVBQUksT0FBTyxXQUFXLEVBQUcsT0FBTSxJQUFJLE1BQU0sK0JBQStCLE9BQU8sT0FBTyxNQUFNLENBQUMsR0FBRztBQUFBLElBQ2xHO0FBQUEsRUFDRixTQUFTLE9BQU87QUFDZCxjQUFVO0FBQUEsRUFDWjtBQUNBLFFBQU0sY0FBYyxDQUFDLGFBQWEsT0FBTyxRQUFRLE9BQU8sR0FBRyxPQUFPO0FBQ3BFOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvd2luZG93cy11dGY4LWNvbnNvbGUubWpzIn0=
