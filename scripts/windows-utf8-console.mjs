// Generated from windows-utf8-console.mts; edit the TypeScript source.
import { createOwnedScratch } from "./owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { settleCleanup } from "./diagnostic-errors.mjs";
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
async function runWindowsUtf8Console(args, builds) {
  if (process.platform !== "win32") throw new Error("A private Windows console requires Windows");
  const scratch = createOwnedScratch(builds, "utf8"), cancellation = processCancellation();
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
          WORKBENCH_NATIVE_CONSOLE_REQUEST: JSON.stringify({ node: process.execPath, arguments: args })
        },
        signal: cancellation.signal,
        owner: scratch.owner
      }
    );
    failure = processFailure("UTF-8 native build", outcome);
  } catch (error) {
    failure = error;
  }
  await settleCleanup([cancellation.close, scratch.release], failure);
}
export {
  runWindowsUtf8Console
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIndpbmRvd3MtdXRmOC1jb25zb2xlLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVPd25lZFNjcmF0Y2ggfSBmcm9tIFwiLi9vd25lZC1zY3JhdGNoLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0NhbmNlbGxhdGlvbiwgcnVuT3duZWRDaGlsZCB9IGZyb20gXCIuL293bmVkLWNoaWxkLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZhaWx1cmUgfSBmcm9tIFwiLi9wcm9jZXNzLW91dGNvbWUubWpzXCI7XG5pbXBvcnQgeyBzZXR0bGVDbGVhbnVwIH0gZnJvbSBcIi4vZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5cbi8vIE1TVkMgcmVkaXJlY3RzIC9zaG93SW5jbHVkZXMgdXNpbmcgdGhlIGNvbnNvbGUgY29kZSBwYWdlLiBHaXZlIHRoZSBidWlsZCBpdHMgb3duIGNvbnNvbGU6XG4vLyBjaGFuZ2luZyBhIGNhbGxlcidzIGNvbnNvbGUgd291bGQgcmFjZSBvdGhlciBidWlsZHMgYW5kIGFsdGVyIHRoZSB1c2VyJ3MgdGVybWluYWwgc2V0dGluZ3MuXG5jb25zdCBsYXVuY2ggPSBTdHJpbmcucmF3YFxuJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJ1xuQWRkLVR5cGUgLVR5cGVEZWZpbml0aW9uIEAnXG51c2luZyBTeXN0ZW07XG51c2luZyBTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXM7XG5wdWJsaWMgc3RhdGljIGNsYXNzIFdvcmtiZW5jaENvbnNvbGUge1xuICBbRGxsSW1wb3J0KFwia2VybmVsMzIuZGxsXCIsIFNldExhc3RFcnJvciA9IHRydWUpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIEZyZWVDb25zb2xlKCk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgQWxsb2NDb25zb2xlKCk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0Q29uc29sZUNQKHVpbnQgcGFnZSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0Q29uc29sZU91dHB1dENQKHVpbnQgcGFnZSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIEludFB0ciBHZXRTdGRIYW5kbGUoaW50IHN0cmVhbSk7XG4gIFtEbGxJbXBvcnQoXCJrZXJuZWwzMi5kbGxcIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0U3RkSGFuZGxlKGludCBzdHJlYW0sIEludFB0ciBoYW5kbGUpO1xuICBbRGxsSW1wb3J0KFwia2VybmVsMzIuZGxsXCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBJbnRQdHIgR2V0Q29uc29sZVdpbmRvdygpO1xuICBbRGxsSW1wb3J0KFwidXNlcjMyLmRsbFwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTaG93V2luZG93KEludFB0ciB3aW5kb3csIGludCBjb21tYW5kKTtcbn1cbidAXG4kaGFuZGxlcyA9IEAoLTEwLCAtMTEsIC0xMikgfCBGb3JFYWNoLU9iamVjdCB7IFtXb3JrYmVuY2hDb25zb2xlXTo6R2V0U3RkSGFuZGxlKCRfKSB9XG5bdm9pZF1bV29ya2JlbmNoQ29uc29sZV06OkZyZWVDb25zb2xlKClcbmlmICgtbm90IFtXb3JrYmVuY2hDb25zb2xlXTo6QWxsb2NDb25zb2xlKCkpIHsgdGhyb3cgJ0Nhbm5vdCBhbGxvY2F0ZSB0aGUgYnVpbGQgY29uc29sZScgfVxudHJ5IHtcbiAgW3ZvaWRdW1dvcmtiZW5jaENvbnNvbGVdOjpTaG93V2luZG93KFtXb3JrYmVuY2hDb25zb2xlXTo6R2V0Q29uc29sZVdpbmRvdygpLCAwKVxuICBmb3IgKCRpID0gMDsgJGkgLWx0IDM7ICRpKyspIHtcbiAgICBpZiAoLW5vdCBbV29ya2JlbmNoQ29uc29sZV06OlNldFN0ZEhhbmRsZSgtMTAgLSAkaSwgJGhhbmRsZXNbJGldKSkgeyB0aHJvdyAnQ2Fubm90IHJlc3RvcmUgYnVpbGQgb3V0cHV0JyB9XG4gIH1cbiAgaWYgKC1ub3QgW1dvcmtiZW5jaENvbnNvbGVdOjpTZXRDb25zb2xlQ1AoNjUwMDEpIC1vciAtbm90IFtXb3JrYmVuY2hDb25zb2xlXTo6U2V0Q29uc29sZU91dHB1dENQKDY1MDAxKSkge1xuICAgIHRocm93ICdDYW5ub3Qgc2VsZWN0IFVURi04IGNvbXBpbGVyIG91dHB1dCdcbiAgfVxuICAkT3V0cHV0RW5jb2RpbmcgPSBbQ29uc29sZV06Ok91dHB1dEVuY29kaW5nID0gTmV3LU9iamVjdCBTeXN0ZW0uVGV4dC5VVEY4RW5jb2RpbmcoJGZhbHNlKVxuICAkcmVxdWVzdCA9ICRlbnY6V09SS0JFTkNIX05BVElWRV9DT05TT0xFX1JFUVVFU1QgfCBDb252ZXJ0RnJvbS1Kc29uXG4gIFJlbW92ZS1JdGVtIEVudjpXT1JLQkVOQ0hfTkFUSVZFX0NPTlNPTEVfUkVRVUVTVFxuICAkYXJndW1lbnRzID0gQCgkcmVxdWVzdC5hcmd1bWVudHMpXG4gICRFcnJvckFjdGlvblByZWZlcmVuY2UgPSAnQ29udGludWUnXG4gICYgJHJlcXVlc3Qubm9kZSBAYXJndW1lbnRzXG4gICRyZXN1bHQgPSAkTEFTVEVYSVRDT0RFXG4gIGlmICgkbnVsbCAtZXEgJHJlc3VsdCkgeyAkcmVzdWx0ID0gMSB9XG59IGZpbmFsbHkge1xuICBbdm9pZF1bV29ya2JlbmNoQ29uc29sZV06OkZyZWVDb25zb2xlKClcbn1cbmV4aXQgJHJlc3VsdFxuYDtcblxuLyoqIFN0cmVhbSBhIG5hdGl2ZSBidWlsZCB0aHJvdWdoIGEgcHJpdmF0ZSBVVEYtOCBXaW5kb3dzIGNvbnNvbGUsIGluY2x1ZGluZyBoaWRkZW4gQ0kgcHJvY2Vzc2VzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bldpbmRvd3NVdGY4Q29uc29sZShhcmdzOiBzdHJpbmdbXSwgYnVpbGRzOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIikgdGhyb3cgbmV3IEVycm9yKFwiQSBwcml2YXRlIFdpbmRvd3MgY29uc29sZSByZXF1aXJlcyBXaW5kb3dzXCIpO1xuICBjb25zdCBzY3JhdGNoID0gY3JlYXRlT3duZWRTY3JhdGNoKGJ1aWxkcywgXCJ1dGY4XCIpLFxuICAgIGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbiAgbGV0IGZhaWx1cmU6IHVua25vd247XG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoXG4gICAgICBcInBvd2Vyc2hlbGwuZXhlXCIsXG4gICAgICBbXG4gICAgICAgIFwiLU5vTG9nb1wiLFxuICAgICAgICBcIi1Ob1Byb2ZpbGVcIixcbiAgICAgICAgXCItTm9uSW50ZXJhY3RpdmVcIixcbiAgICAgICAgXCItRW5jb2RlZENvbW1hbmRcIixcbiAgICAgICAgQnVmZmVyLmZyb20obGF1bmNoLCBcInV0ZjE2bGVcIikudG9TdHJpbmcoXCJiYXNlNjRcIiksXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFRFTVA6IHNjcmF0Y2guZGlyZWN0b3J5LFxuICAgICAgICAgIFRNUDogc2NyYXRjaC5kaXJlY3RvcnksXG4gICAgICAgICAgV09SS0JFTkNIX05BVElWRV9VVEY4X0NPTlNPTEU6IFwiMVwiLFxuICAgICAgICAgIFdPUktCRU5DSF9OQVRJVkVfQ09OU09MRV9SRVFVRVNUOiBKU09OLnN0cmluZ2lmeSh7IG5vZGU6IHByb2Nlc3MuZXhlY1BhdGgsIGFyZ3VtZW50czogYXJncyB9KSxcbiAgICAgICAgfSxcbiAgICAgICAgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsLFxuICAgICAgICBvd25lcjogc2NyYXRjaC5vd25lcixcbiAgICAgIH0sXG4gICAgKTtcbiAgICBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoXCJVVEYtOCBuYXRpdmUgYnVpbGRcIiwgb3V0Y29tZSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZSA9IGVycm9yO1xuICB9XG4gIGF3YWl0IHNldHRsZUNsZWFudXAoW2NhbmNlbGxhdGlvbi5jbG9zZSwgc2NyYXRjaC5yZWxlYXNlXSwgZmFpbHVyZSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLHFCQUFxQixxQkFBcUI7QUFDbkQsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxxQkFBcUI7QUFJOUIsTUFBTSxTQUFTLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUEwQ3RCLGVBQXNCLHNCQUFzQixNQUFnQixRQUErQjtBQUN6RixNQUFJLFFBQVEsYUFBYSxRQUFTLE9BQU0sSUFBSSxNQUFNLDRDQUE0QztBQUM5RixRQUFNLFVBQVUsbUJBQW1CLFFBQVEsTUFBTSxHQUMvQyxlQUFlLG9CQUFvQjtBQUNyQyxNQUFJO0FBQ0osTUFBSTtBQUNGLFVBQU0sVUFBVSxNQUFNO0FBQUEsTUFDcEI7QUFBQSxNQUNBO0FBQUEsUUFDRTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0EsT0FBTyxLQUFLLFFBQVEsU0FBUyxFQUFFLFNBQVMsUUFBUTtBQUFBLE1BQ2xEO0FBQUEsTUFDQTtBQUFBLFFBQ0UsS0FBSyxRQUFRLElBQUk7QUFBQSxRQUNqQixLQUFLO0FBQUEsVUFDSCxHQUFHLFFBQVE7QUFBQSxVQUNYLE1BQU0sUUFBUTtBQUFBLFVBQ2QsS0FBSyxRQUFRO0FBQUEsVUFDYiwrQkFBK0I7QUFBQSxVQUMvQixrQ0FBa0MsS0FBSyxVQUFVLEVBQUUsTUFBTSxRQUFRLFVBQVUsV0FBVyxLQUFLLENBQUM7QUFBQSxRQUM5RjtBQUFBLFFBQ0EsUUFBUSxhQUFhO0FBQUEsUUFDckIsT0FBTyxRQUFRO0FBQUEsTUFDakI7QUFBQSxJQUNGO0FBQ0EsY0FBVSxlQUFlLHNCQUFzQixPQUFPO0FBQUEsRUFDeEQsU0FBUyxPQUFPO0FBQ2QsY0FBVTtBQUFBLEVBQ1o7QUFDQSxRQUFNLGNBQWMsQ0FBQyxhQUFhLE9BQU8sUUFBUSxPQUFPLEdBQUcsT0FBTztBQUNwRTsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3dpbmRvd3MtdXRmOC1jb25zb2xlLm1qcyJ9
