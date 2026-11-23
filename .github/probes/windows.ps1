$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP ('workbench-scope-' + [guid]::NewGuid().ToString('N'))
$inputPath = Join-Path $work 'input'
$outputPath = Join-Path $work 'output'
$outsidePath = Join-Path $work 'outside'
$profile = 'wb.scope.' + [guid]::NewGuid().ToString('N')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class ScopeProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint size;
    public string reserved, desktop, title;
    public uint x,y,width,height,columns,rows,fill,flags;
    public ushort show, reserved2;
    public IntPtr pointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup {
    public Startup startup;
    public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread;
    public uint pid, tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities {
    public IntPtr sid, capabilities;
    public uint count, reserved;
  }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr oldValue, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref ExtendedStartup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint status);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  public static IntPtr Create(string name) {
    IntPtr sid;
    Marshal.ThrowExceptionForHR(CreateAppContainerProfile(name, name, "Workbench scope probe", IntPtr.Zero, 0, out sid));
    return sid;
  }
  public static void Release(string name, IntPtr sid) {
    FreeSid(sid);
    Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(name));
  }
  public static string Identity(IntPtr sid) {
    return new SecurityIdentifier(sid).Value;
  }
  static void Require(bool value) { if(!value) throw new Win32Exception(); }
  public static uint Run(IntPtr sid, string directory, string executable) {
    IntPtr bytes = IntPtr.Zero, attributes = IntPtr.Zero, arguments = IntPtr.Zero;
    var p = new ProcessInfo();
    bool initialized = false;
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
      attributes = Marshal.AllocHGlobal(bytes);
      Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes));
      initialized = true;
      int size = Marshal.SizeOf(typeof(SecurityCapabilities));
      arguments = Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(new SecurityCapabilities { sid = sid }, arguments, false);
      Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), arguments, new IntPtr(size), IntPtr.Zero, IntPtr.Zero));
      var startup = new ExtendedStartup {
        startup = new Startup { size = (uint)Marshal.SizeOf(typeof(ExtendedStartup)) },
        attributes = attributes
      };
      Require(CreateProcessW(executable, new StringBuilder("\"" + executable + "\" /D /C probe.cmd"),
        IntPtr.Zero, IntPtr.Zero, false, 0x80000 | 0x8000000, IntPtr.Zero, directory, ref startup, out p));
      if (WaitForSingleObject(p.process, 15000) != 0) {
        TerminateProcess(p.process, 124);
        throw new Exception("AppContainer child did not finish");
      }
      uint status;
      Require(GetExitCodeProcess(p.process, out status));
      return status;
    } finally {
      if (p.thread != IntPtr.Zero) CloseHandle(p.thread);
      if (p.process != IntPtr.Zero) CloseHandle(p.process);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (arguments != IntPtr.Zero) Marshal.FreeHGlobal(arguments);
    }
  }
}
'@
$sid = [ScopeProbe]::Create($profile)
try {
  New-Item -ItemType Directory $inputPath,$outputPath,$outsidePath | Out-Null
  Set-Content -LiteralPath (Join-Path $inputPath 'expected.txt') 'visible'
  Set-Content -LiteralPath (Join-Path $outsidePath 'omitted.txt') 'private'
  $descendant = @"
@echo off
type "$outsidePath\omitted.txt" > "$outputPath\unscoped" 2>nul
exit /b 0
"@
  Set-Content -LiteralPath (Join-Path $inputPath 'child.cmd') $descendant
  $fixture = @"
@echo off
type "$inputPath\expected.txt" > "$outputPath\readback" || exit /b 2
call "%SystemRoot%\System32\cmd.exe" /D /C child.cmd > "$outputPath\descendant.txt" 2>&1 || exit /b 3
(echo changed >> expected.txt) 2>nul
echo report > "$outputPath\pending" || exit /b 5
ren "$outputPath\pending" final > "$outputPath\rename.log" 2>&1 || exit /b 6
"@
  Set-Content -LiteralPath (Join-Path $inputPath 'probe.cmd') $fixture
  $identity = [System.Security.Principal.SecurityIdentifier]::new([ScopeProbe]::Identity($sid))
  foreach ($directory in @($inputPath, $outputPath)) {
    $rights = if ($directory -eq $inputPath) { 'ReadAndExecute' } else { 'Modify' }
    $acl = Get-Acl -LiteralPath $directory
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $directory -AclObject $acl
  }
  # The source remains inaccessible even if inherited RunnerTemp ACLs grant broad read access.
  $outsideAcl = Get-Acl -LiteralPath $outsidePath
  $outsideAcl.SetAccessRuleProtection($true, $false)
  $parentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $outsideAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $parentIdentity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $outsidePath -AclObject $outsideAcl

  & icacls $outputPath /setintegritylevel '(OI)(CI)L'
  if ($LASTEXITCODE -ne 0) { throw 'Could not label the private output directory' }
  $exitCode = [ScopeProbe]::Run($sid, $inputPath, $env:ComSpec)
  Write-Host "AppContainer exit status: $exitCode"
  foreach ($log in Get-ChildItem -LiteralPath $outputPath) {
    Write-Host "Output: $($log.Name)"
    if ($log.Name -in @('descendant.txt', 'rename.log')) { Get-Content -LiteralPath $log.FullName | ForEach-Object { Write-Host $_ } }
  }
  if ($exitCode -ne 0) { throw "AppContainer child exited with status $exitCode" }
  $outOfScope = Join-Path $outputPath 'unscoped'
  if (!(Test-Path -LiteralPath $outOfScope)) { throw 'Child did not run' }
  if ((Get-Item -LiteralPath $outOfScope).Length -ne 0) { throw 'Child read undeclared input' }
  if ((Get-Content -Raw (Join-Path $outputPath 'readback')).Trim() -ne 'visible') { throw 'Wrong input' }
  if ((Get-Content -Raw (Join-Path $inputPath 'expected.txt')).Trim() -ne 'visible') { throw 'Source changed' }
  if ((Get-Content -Raw (Join-Path $outputPath 'final')).Trim() -ne 'report') { throw 'Wrong output' }
} finally {
  [ScopeProbe]::Release($profile, $sid)
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Force -Recurse }
}
