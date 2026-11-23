param([string]$RuntimePath = (Get-Command node.exe).Source)

$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP ('workbench-scope-' + [guid]::NewGuid().ToString('N'))
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
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
  public static string Folder(IntPtr sid) {
    IntPtr path;
    Marshal.ThrowExceptionForHR(GetAppContainerFolderPath(Identity(sid), out path));
    try { return Marshal.PtrToStringUni(path); }
    finally { Marshal.FreeCoTaskMem(path); }
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr oldValue, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref ExtendedStartup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint status);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int stream);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr handle, IntPtr to, out IntPtr copy, uint access, bool inherit, uint flags);

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
  public static uint Run(IntPtr sid, string directory, string executable, string commandArguments) {
    IntPtr bytes = IntPtr.Zero, attributes = IntPtr.Zero, arguments = IntPtr.Zero;
    var p = new ProcessInfo();
    var inherited = new IntPtr[3];
    IntPtr handles = IntPtr.Zero;
    bool initialized = false;
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
      attributes = Marshal.AllocHGlobal(bytes);
      Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes));
      initialized = true;
      int size = Marshal.SizeOf(typeof(SecurityCapabilities));
      arguments = Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(new SecurityCapabilities { sid = sid }, arguments, false);
      Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), arguments, new IntPtr(size), IntPtr.Zero, IntPtr.Zero));
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      for (int i = 0; i < 3; i++) {
        Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10 - i), GetCurrentProcess(), out inherited[i], 0, true, 2));
        Marshal.WriteIntPtr(handles, i * IntPtr.Size, inherited[i]);
      }
      Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var startup = new ExtendedStartup {
        startup = new Startup { size = (uint)Marshal.SizeOf(typeof(ExtendedStartup)), flags = 0x100, input = inherited[0], output = inherited[1], error = inherited[2] },
        attributes = attributes
      };
      Require(CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + commandArguments),
        IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x8000000, IntPtr.Zero, directory, ref startup, out p));
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
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      foreach (var h in inherited) if (h != IntPtr.Zero) CloseHandle(h);
    }
  }
}
'@
$sid = [ScopeProbe]::Create($profile)
try {
  $drive = $null
  $container = Join-Path ([ScopeProbe]::Folder($sid)) 'LocalState'
  $inputPath = Join-Path $container 'input'
  $outputPath = Join-Path $container 'output'
  New-Item -Force -ItemType Directory $inputPath,$outputPath,$outsidePath | Out-Null
  Set-Content -LiteralPath (Join-Path $inputPath 'expected.txt') 'visible'
  Set-Content -LiteralPath (Join-Path $outsidePath 'omitted.txt') 'private'
  $identity = [System.Security.Principal.SecurityIdentifier]::new([ScopeProbe]::Identity($sid))
  foreach ($directory in @($inputPath, $outputPath)) {
    $rights = if ($directory -eq $inputPath) { 'ReadAndExecute' } else { 'Modify' }
    $acl = Get-Acl -LiteralPath $directory
    if ($directory -eq $inputPath) {
      $acl.SetAccessRuleProtection($true, $false)
      $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
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

  $drive = 'W:'
  if (Test-Path "$drive\") { throw 'Probe drive already in use' }
  & subst $drive $container
  if ($LASTEXITCODE -ne 0) { throw 'Could not map the private scope drive' }
  $inputPath = "$drive\input"
  $outputPath = "$drive\output"
  $node = Join-Path $inputPath 'node.exe'
  Copy-Item -LiteralPath $RuntimePath -Destination $node
  $probe = @"
const fs = require('node:fs');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const output = $($outputPath | ConvertTo-Json -Compress);
const omitted = $(Join-Path $outsidePath 'omitted.txt' | ConvertTo-Json -Compress);
(async () => {
  assert.equal(fs.readFileSync('expected.txt','utf8').trim(), 'visible');
  console.log('Declared input read with Node', process.version, 'libuv', process.versions.uv);
  const child = spawnSync(process.execPath, ['-e', 'require("node:fs").readFileSync(process.argv[1])', omitted], {encoding: 'utf8', timeout: 5000});
  if (child.error) throw child.error;
  assert.equal(child.status, 1);
  assert.match(child.stderr, /EPERM|EACCES/);
  console.log('Descendant denied omitted input');
  await new Promise((resolve, reject) => {
    const ipc = fork('ipc.cjs', [], { silent: true });
    let message;
    ipc.once('message', (value) => { message = value; });
    ipc.once('error', reject);
    ipc.once('close', (code, signal) => {
      try {
        assert.equal(code, 0, signal);
        assert.equal(message, 'child IPC');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  console.log('Node child IPC worked inside AppContainer');
  assert.throws(() => fs.appendFileSync('expected.txt', 'changed'), /EPERM|EACCES/);
  const pending = path.join(output, 'pending');
  fs.writeFileSync(pending, 'report');
  console.log('Private output created');
  fs.renameSync(pending, path.join(output, 'final'));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"@
  Set-Content -LiteralPath (Join-Path $inputPath 'ipc.cjs') "process.send('child IPC', () => process.disconnect());"
  Set-Content -LiteralPath (Join-Path $inputPath 'probe.cjs') $probe
  $exitCode = [ScopeProbe]::Run($sid, $inputPath, $node, 'probe.cjs')
  Write-Host "AppContainer Node exit status: $exitCode"
  if ($exitCode -ne 0) { throw "AppContainer Node exited with status $exitCode" }
  if ((Get-Content -Raw (Join-Path $outputPath 'final')).Trim() -ne 'report') { throw 'Wrong output' }
} finally {
  if ($drive -and (Test-Path "$drive\")) { & subst $drive /d }
  [ScopeProbe]::Release($profile, $sid)
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Force -Recurse }
}
