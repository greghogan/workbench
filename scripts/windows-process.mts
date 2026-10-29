import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { readBoundedFile } from "../src/file-reads.js";
import { isRecord } from "./values.mjs";
import { windowsExecutableArgument } from "./windows-arguments.mjs";
import { windowsProcessLaunch } from "./windows-process-launch.mjs";

export interface WindowsProcessOutcome {
  pid: number;
  status: number | null;
  jobEmpty: boolean;
  error?: Error;
}
export interface WindowsProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "pipe" | "inherit" | "ignore";
  output?: "pipe" | "inherit";
  windowsVerbatimArguments?: boolean;
  stopDescendantsOnExit?: boolean;
}
export interface WindowsProcess {
  child: ChildProcessByStdio<Writable | null, Readable | null, Readable | null>;
  directory: string;
  ready: Promise<void>;
  admit(): Promise<void>;
  cancel(): void;
  completion: Promise<WindowsProcessOutcome>;
  dispose(): Promise<void>;
}
const environmentValue = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  env[
    Object.keys(env)
      .sort()
      .find((key) => key.toUpperCase() === name && env[key] !== undefined) ?? ""
  ];

/** Match Node's case-insensitive, first-lexicographic-key Windows environment selection. */
export function windowsProcessEnvironment(env: NodeJS.ProcessEnv): string {
  const seen = new Set<string>();
  const entries: { name: string; value: string }[] = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined || seen.has(name.toUpperCase())) continue;
    if (!name || name.includes("=") || name.includes("\0") || value.includes("\0"))
      throw new Error("Invalid Windows process environment");
    seen.add(name.toUpperCase());
    entries.push({ name, value });
  }
  entries.sort((a, b) => (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
  return entries.map(({ name, value }) => `${name}=${value}`).join("\0") + "\0\0";
}
export function windowsProcessCommand(command: string, args: readonly string[], verbatim = false): string {
  if ([command, ...args].some((argument) => argument.includes("\0")))
    throw new Error("Windows process arguments contain a null byte");
  return [
    windowsExecutableArgument(command),
    ...args.map((arg) => (verbatim ? arg : windowsExecutableArgument(arg))),
  ].join(" ");
}
export function decodeWindowsProcessOutcome(input: unknown, token: string): WindowsProcessOutcome {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    input.token !== token ||
    Object.keys(input).some((key) => !["version", "token", "pid", "status", "jobEmpty", "error"].includes(key)) ||
    typeof input.pid !== "number" ||
    !Number.isSafeInteger(input.pid) ||
    input.pid < 0 ||
    input.pid > 0xffffffff ||
    (input.status !== null &&
      (typeof input.status !== "number" ||
        !Number.isSafeInteger(input.status) ||
        input.status < 0 ||
        input.status > 0xffffffff)) ||
    typeof input.jobEmpty !== "boolean" ||
    (input.error !== null && (typeof input.error !== "string" || !input.error.trim() || input.error.length > 8192)) ||
    (input.pid === 0 && input.status !== null) ||
    (input.pid !== 0 && input.status === null && input.error === null)
  )
    throw new Error("Invalid Windows job completion proof");
  return {
    pid: input.pid,
    status: input.status,
    jobEmpty: input.jobEmpty,
    ...(typeof input.error === "string" ? { error: new Error(input.error) } : {}),
  };
}
export function windowsProcessExecutable(
  command: string,
  options: Pick<WindowsProcessOptions, "cwd" | "env">,
  isFile: (path: string) => boolean = (path) => statSync(path).isFile(),
): string {
  const name = /\.(?:exe|com)$/i.test(command) ? command : `${command}.exe`;
  const paths = /[/\\]/.test(command)
    ? [win32.resolve(options.cwd, name)]
    : [options.cwd, ...(environmentValue(options.env, "PATH") ?? "").split(";")].map((directory) =>
        win32.resolve(options.cwd, directory.replace(/^"(.*)"$/, "$1"), name),
      );
  for (const path of paths)
    try {
      if (isFile(path)) return path;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  throw Object.assign(new Error(`Cannot resolve Windows executable: ${command}`), { code: "ENOENT" });
}

/** An authenticated control-pipe lifetime owns the job even after the original command exits. */
export async function spawnWindowsProcess(
  command: string,
  args: string[],
  options: WindowsProcessOptions,
): Promise<WindowsProcess> {
  if (process.platform !== "win32") throw new Error("Windows process jobs require Windows");
  const target = windowsProcessExecutable(command, options);
  const environment = Buffer.from(windowsProcessEnvironment(options.env), "utf16le").toString("base64");
  const commandLine = windowsProcessCommand(target, args, options.windowsVerbatimArguments);
  const hide =
    options.stdin !== "inherit" &&
    options.output !== "inherit" &&
    environmentValue(options.env, "WORKBENCH_NATIVE_UTF8_CONSOLE") !== "1";
  const directory = mkdtempSync(join(tmpdir(), "workbench-process-"));
  const pipe = `workbench-process-${randomUUID()}`,
    token = randomUUID();
  const request = join(directory, "request.json"),
    result = join(directory, "result.json"),
    script = join(directory, "launch.ps1");
  const server = createServer(),
    clients = new Set<Socket>();
  let channel: Socket | undefined,
    admitted = false,
    canceled = false,
    settled = false;
  let failure: Error | undefined, resolveReady!: () => void, rejectReady!: (error: Error) => void;
  let child: ChildProcessByStdio<Writable | null, Readable | null, Readable | null>;
  let stopping: ReturnType<typeof setTimeout> | undefined;
  let abandon: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const cancel = () => {
    if (settled || canceled) return;
    canceled = true;
    if (channel && !channel.destroyed) channel.write(Buffer.from([2]));
    if (!admitted) {
      const stopSupervisor = () => {
        if (settled || admitted) return;
        try {
          child.kill();
        } catch (cause) {
          // The live supervisor handle owns no admitted target.
          failure ??= new Error("Cannot stop Windows process startup", { cause });
        }
        stopping = setTimeout(() => {
          abandon?.();
        }, 1000);
        stopping.unref();
      };
      if (channel) stopping = setTimeout(stopSupervisor, 100);
      else stopSupervisor();
    }
  };
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.setTimeout(5000, () => {
      socket.destroy();
    });
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (socket === channel) {
        failure ??= new Error("Unexpected Windows process control message");
        cancel();
        return;
      }
      if (bytes.length + chunk.length > 256) {
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.includes(10)) {
        if (!bytes.equals(Buffer.from(token + "\n", "ascii")) || channel) {
          socket.destroy();
          return;
        }
        channel = socket;
        socket.setTimeout(0);
        clearTimeout(startup);
        try {
          rmSync(request, { force: true });
        } catch (cause) {
          failure ??= new Error("Cannot remove Windows process startup request", { cause });
          cancel();
          rejectReady(failure);
          return;
        }
        if (canceled) socket.write(Buffer.from([2]));
        resolveReady();
      }
    });
    socket.on("error", (error) => {
      if (socket === channel && !settled) {
        failure ??= error;
        cancel();
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
    });
  });
  const closeServer = async () => {
    for (const socket of clients) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen("\\\\.\\pipe\\" + pipe, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error) => {
      failure ??= error;
      cancel();
    });
    writeFileSync(
      request,
      JSON.stringify({
        executable: target,
        commandLine,
        cwd: options.cwd,
        environment,
        pipe,
        token,
        result,
        stopOnExit: options.stopDescendantsOnExit === true,
        hide,
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(script, windowsProcessLaunch, { flag: "wx", mode: 0o600 });
    const system = environmentValue(options.env, "SYSTEMROOT") ?? environmentValue(process.env, "SYSTEMROOT");
    if (!system) throw new Error("Windows process supervision requires SystemRoot");
    const powershell = win32.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const settings = {
      cwd: options.cwd,
      env: { ...options.env, WORKBENCH_PROCESS_REQUEST: request },
      windowsHide: hide,
    };
    const arguments_ = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
    const output = options.output ?? "pipe";
    child = spawn(powershell, arguments_, { ...settings, stdio: [options.stdin, output, output] });
  } catch (error) {
    await closeServer();
    rmSync(directory, { recursive: true });
    throw error;
  }
  child.once("error", (error) => {
    failure ??= error;
    rejectReady(error);
  });
  const startup = setTimeout(() => {
    failure ??= new Error("Windows job supervisor did not become ready");
    rejectReady(failure);
    cancel();
    // No target admission has occurred: closing the control endpoint forbids a later launch.
    for (const socket of clients) socket.destroy();
    server.close();
  }, 30000);
  startup.unref();
  const completion = new Promise<WindowsProcessOutcome>((resolve) => {
    const finish = (proof: WindowsProcessOutcome, detach = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      clearTimeout(stopping);
      if (detach) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      if (!admitted)
        try {
          rmSync(request, { force: true });
        } catch (cause) {
          const cleanup = new Error("Cannot remove Windows process startup request", { cause });
          proof.error = proof.error
            ? new AggregateError([proof.error, cleanup], "Windows startup and cleanup failed", { cause: proof.error })
            : cleanup;
        }
      rejectReady(proof.error ?? new Error("Windows job supervisor ended before admission"));
      void closeServer().then(
        () => {
          resolve(proof);
        },
        (error: unknown) => {
          resolve({ ...proof, jobEmpty: false, error: new Error("Windows control cleanup failed", { cause: error }) });
        },
      );
    };
    abandon = () => {
      finish(
        {
          pid: 0,
          status: null,
          jobEmpty: false,
          error: new Error(`Windows supervisor did not close after startup cancellation; preserving ${directory}`),
        },
        true,
      );
    };
    child.once("close", (status, signal) => {
      if (settled) return;
      let proof: WindowsProcessOutcome;
      try {
        proof = decodeWindowsProcessOutcome(
          JSON.parse(readBoundedFile(result, 16384, "Windows job completion").toString("utf8")),
          token,
        );
        if (signal !== null || (status !== 0 && !proof.error))
          throw new Error("Windows job supervisor ended unexpectedly");
        if (proof.pid !== 0 && !admitted) throw new Error("Windows job ran without admission");
        if (failure)
          proof.error = proof.error
            ? new AggregateError([proof.error, failure], "Windows process and control failed", { cause: proof.error })
            : failure;
      } catch (error) {
        proof =
          child.pid === undefined && failure
            ? { pid: 0, status: null, jobEmpty: true, error: failure }
            : {
                pid: 0,
                status: null,
                jobEmpty: false,
                error: new Error(`Windows job ownership is uncertain; preserving ${directory}`, { cause: error }),
              };
      }
      finish(proof);
    });
  });
  return {
    child,
    directory,
    ready,
    cancel,
    completion,
    async admit() {
      await ready;
      if (admitted) throw new Error("Windows process was already admitted");
      if (settled || canceled) return;
      if (!channel || channel.destroyed) throw new Error("Windows process control disconnected before admission");
      admitted = true;
      channel.write(Buffer.from([1]));
    },
    async dispose() {
      if (!(await completion).jobEmpty) throw new Error(`Windows job ownership is uncertain; preserving ${directory}`);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
