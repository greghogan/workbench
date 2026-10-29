// Win10 creation-time JOB_LIST closes the orphan window between process creation and assignment.
// https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/
export const windowsProcessLaunch = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$requestPath = $env:WORKBENCH_PROCESS_REQUEST
$request = [System.IO.File]::ReadAllText($requestPath) | ConvertFrom-Json
[System.IO.File]::Delete($requestPath)
Remove-Item Env:WORKBENCH_PROCESS_REQUEST
Add-Type -ReferencedAssemblies System.dll,System.Core.dll -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class WorkbenchProcessResult {
  public int version = 1;
  public uint pid;
  public long? status;
  public bool jobEmpty;
  public string error;
}
public static class WorkbenchProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime;
    public uint flags;
    public UIntPtr minimumWorkingSet, maximumWorkingSet;
    public uint activeLimit;
    public UIntPtr affinity;
    public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic;
    public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint faults, processes, active, terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public uint cb;
    public string reserved, desktop, title;
    public uint x, y, width, height, columns, rows, fill, flags;
    public ushort show, reservedBytes;
    public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo startup;
    public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread;
    public uint pid, tid;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint status);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint status);

  static Win32Exception Failure(string operation) {
    int code = Marshal.GetLastWin32Error();
    return new Win32Exception(code, operation + " (Win32 " + code + ": " + new Win32Exception(code).Message + ")");
  }
  static void Require(bool success, string operation) {
    if (!success) throw Failure(operation);
  }
  static uint Active(IntPtr job) {
    Accounting info;
    Require(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Cannot query owned Windows job");
    return info.active;
  }
  static bool Reap(IntPtr job) {
    Require(TerminateJobObject(job, 1), "Cannot terminate owned Windows job");
    var elapsed = Stopwatch.StartNew();
    while (Active(job) != 0) {
      if (elapsed.ElapsedMilliseconds >= 10000) return false;
      Thread.Sleep(10);
    }
    return true;
  }
  public static WorkbenchProcessResult Run(string executable, string command, string cwd, string environment, string pipeName, string token, bool stopOnExit, bool hide) {
    var result = new WorkbenchProcessResult();
    IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, env = IntPtr.Zero;
    IntPtr[] inherited = new IntPtr[3];
    var process = new ProcessInfo();
    bool initialized = false, created = false;
    NamedPipeClientStream control = null;
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      Require(job != IntPtr.Zero, "Cannot create owned Windows job");
      var limits = new ExtendedLimits();
      limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is enabled.
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Cannot protect owned Windows job");
      control = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
      control.Connect(30000);
      byte[] ready = Encoding.ASCII.GetBytes(token + "\n");
      control.Write(ready, 0, ready.Length);
      control.Flush();
      int admission = control.ReadByte();
      if (admission != 1) {
        if (admission != -1 && admission != 2) throw new IOException("Invalid Windows process admission");
        result.jobEmpty = true;
        return result;
      }
      var cancellation = Task.Factory.StartNew(() => control.ReadByte());
      IntPtr bytes = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
      attributes = Marshal.AllocHGlobal(bytes);
      Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes), "Cannot initialize Windows process attributes");
      initialized = true;
      jobs = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobs, job);
      Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Cannot assign creation-time Windows job");
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      for (int index = 0; index < 3; index++) {
        Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10 - index), GetCurrentProcess(), out inherited[index], 0, true, 2), "Cannot inherit Windows standard handle");
        Marshal.WriteIntPtr(handles, index * IntPtr.Size, inherited[index]);
      }
      Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Cannot restrict Windows handle inheritance");
      var startup = new StartupInfoEx();
      startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
      startup.startup.flags = 0x100;
      startup.startup.input = inherited[0];
      startup.startup.output = inherited[1];
      startup.startup.error = inherited[2];
      startup.attributes = attributes;
      env = Marshal.StringToHGlobalUni(environment);
      // A lost coordinator before creation cannot authorize work merely by having sent admission earlier.
      if (cancellation.IsCompleted) { result.jobEmpty = true; return result; }
      Require(CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | (hide ? 0x8000000u : 0u), env, cwd, ref startup, out process), "Cannot create process in owned Windows job");
      created = true;
      result.pid = process.pid;
      bool stopped = false, rootExited = false;
      var stopping = new Stopwatch();
      for (;;) {
        if (!rootExited) {
          uint wait = WaitForSingleObject(process.process, 0);
          if (wait == 0xFFFFFFFF) throw Failure("Cannot wait for owned Windows process");
          if (wait == 0) {
            uint status;
            Require(GetExitCodeProcess(process.process, out status), "Cannot read owned Windows process status");
            result.status = (long)status;
            rootExited = true;
          }
        }
        if (!stopped && (cancellation.IsCompleted || (rootExited && stopOnExit))) {
          if (cancellation.IsCompleted) {
            int message = cancellation.GetAwaiter().GetResult();
            if (message != -1 && message != 2) throw new IOException("Invalid Windows process control message");
          }
          Require(TerminateJobObject(job, 1), "Cannot cancel owned Windows job");
          stopped = true;
          stopping.Start();
        }
        if (Active(job) == 0 && rootExited) { result.jobEmpty = true; break; }
        if (stopped && stopping.ElapsedMilliseconds >= 10000) throw new IOException("Owned Windows job did not empty after cancellation");
        Thread.Sleep(10);
      }
    } catch (Exception error) {
      result.error = error.Message;
    } finally {
      if (!created) result.jobEmpty = true;
      if (job != IntPtr.Zero && !result.jobEmpty) {
        try { result.jobEmpty = !created || Reap(job); }
        catch (Exception cleanup) { result.error = (result.error == null ? "" : result.error + "; ") + cleanup.Message; }
      }
      if (created && result.status == null && result.jobEmpty) {
        uint status;
        if (GetExitCodeProcess(process.process, out status)) result.status = (long)status;
        else result.error = (result.error == null ? "" : result.error + "; ") + "Cannot read terminated Windows process status";
      }
      if (control != null) control.Dispose();
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      foreach (IntPtr handle in inherited) if (handle != IntPtr.Zero) CloseHandle(handle);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
    return result;
  }
}
'@
$result = [WorkbenchProcessJob]::Run($request.executable, $request.commandLine, $request.cwd, [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($request.environment)), $request.pipe, $request.token, $request.stopOnExit, $request.hide)
$result | Add-Member -NotePropertyName token -NotePropertyValue $request.token
[System.IO.File]::WriteAllText($request.result, (ConvertTo-Json -InputObject $result -Compress))
if ($null -ne $result.error) { exit 1 }
exit 0
`;
