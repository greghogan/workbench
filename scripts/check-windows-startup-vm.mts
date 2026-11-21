import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { processCancellation, runOwnedChild } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { createOwnedScratch } from "../app/src/core/runtime/owned-scratch.mjs";
import { combineFailures } from "../app/src/core/diagnostics/diagnostic-errors.mjs";
import { isRecord } from "../app/src/core/runtime/values.mjs";
import { serviceCandidate, verifyServiceInput, type VerifiedInput } from "./service-check-inputs.mts";
import { isMainScript } from "./script-entry.mts";

const manifestName = "WORKBENCH_WINDOWS_STARTUP_INPUTS";
const deadlineMs = 20 * 60_000;
interface WindowsStartupInputs {
  image: VerifiedInput;
  node: VerifiedInput;
  firmware?: { code: VerifiedInput; variables: VerifiedInput };
  tools?: string;
}

function input(value: unknown, name: string): VerifiedInput {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.sha256 !== "string")
    throw new Error(`${manifestName} must declare ${name}.path and ${name}.sha256`);
  return { path: value.path, sha256: value.sha256 };
}

function inputs(): WindowsStartupInputs {
  const manifest = process.env[manifestName];
  if (!manifest || !isAbsolute(manifest))
    throw new Error(
      `Set ${manifestName} to an absolute JSON file with the verified Windows guest image and Node.js executable`,
    );
  const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (!isRecord(value)) throw new Error(`Invalid ${manifestName} manifest`);
  const tools = value.tools;
  if (tools !== undefined && (typeof tools !== "string" || !isAbsolute(tools)))
    throw new Error(`${manifestName} tools must be an absolute directory`);
  const required = {
    image: input(value.image, "image"),
    node: input(value.node, "node"),
    ...(tools === undefined ? {} : { tools }),
  };
  const firmware = value.firmware;
  if (firmware === undefined) return required;
  if (!isRecord(firmware)) throw new Error(`${manifestName} firmware requires code and variables inputs`);
  return {
    ...required,
    firmware: {
      code: input(firmware.code, "firmware.code"),
      variables: input(firmware.variables, "firmware.variables"),
    },
  };
}

export async function runWindowsStartup(
  { image, node, firmware, tools }: WindowsStartupInputs,
  signal: AbortSignal,
): Promise<void> {
  const candidate = await serviceCandidate(signal);
  await verifyServiceInput(image, "Windows guest base image", signal);
  await verifyServiceInput(node, "Windows Node.js executable", signal);
  const scratch = createOwnedScratch(tmpdir(), "workbench-windows-startup");
  const temporary = scratch.directory;
  try {
    const overlay = join(temporary, "guest.qcow2");
    const payload = join(temporary, "wbcheck");
    const boot: string[] = [];
    if (firmware) {
      for (const [name, source] of [
        ["uefi-code.fd", firmware.code],
        ["uefi-vars.fd", firmware.variables],
      ] as const) {
        const path = join(temporary, name);
        await verifyServiceInput(source, name, signal);
        copyFileSync(source.path, path);
        await verifyServiceInput({ ...source, path }, name, signal);
      }
      chmodSync(join(temporary, "uefi-vars.fd"), 0o600);
      boot.push(
        "-drive",
        "if=pflash,format=raw,readonly=on,file=uefi-code.fd",
        "-drive",
        "if=pflash,format=raw,file=uefi-vars.fd",
      );
    }
    mkdirSync(payload);
    for (const [source, target] of [
      [node.path, "node.exe"],
      [candidate.path, "workbench.tar.gz"],
      [join(import.meta.dirname, "check-windows-startup.ps1"), "verify.ps1"],
      [join(import.meta.dirname, "windows-startup-bootstrap.ps1"), "start.ps1"],
    ] as const)
      copyFileSync(source, join(payload, target));
    await verifyServiceInput({ ...node, path: join(payload, "node.exe") }, "Windows Node.js executable", signal);
    await verifyServiceInput(
      { ...candidate, path: join(payload, "workbench.tar.gz") },
      "Workbench candidate archive",
      signal,
    );
    writeFileSync(join(payload, "digest.txt"), candidate.sha256 + "\n");
    const firstBoot = join(temporary, "start.cmd");
    writeFileSync(
      firstBoot,
      [
        "@echo off",
        String.raw`if exist C:\wbcheck\started exit /b 250`,
        String.raw`echo started > C:\wbcheck\started`,
        String.raw`set "workbench_powershell=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"`,
        String.raw`if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "workbench_powershell=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"`,
        String.raw`"%workbench_powershell%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\wbcheck\start.ps1`,
        "exit /b 250",
        "",
      ].join("\r\n"),
    );

    const environment = { ...process.env };
    delete environment.GH_TOKEN;
    delete environment.GITHUB_TOKEN;
    const run = async (
      command: string,
      args: string[],
      output: Parameters<typeof runOwnedChild>[2]["output"],
      stop: AbortSignal = signal,
    ) => {
      stop.throwIfAborted();
      const result = await runOwnedChild(tools ? join(tools, command) : command, args, {
        cwd: temporary,
        env: environment,
        signal: stop,
        owner: scratch.owner,
        stopDescendantsOnExit: true,
        ...(output ? { output } : {}),
      });
      if (result.descendantsActive) throw new Error(`Guest process termination is uncertain: ${temporary}`);
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`Windows startup qualification requires ${command} in ${tools ?? "the host PATH"}`);
      return result;
    };
    const execute = async (command: string, args: string[], output?: Parameters<typeof runOwnedChild>[2]["output"]) => {
      const result = await run(command, args, output);
      signal.throwIfAborted();
      const failure = processFailure(command, result);
      if (failure) throw failure;
    };
    let imageInfo = "";
    await execute("qemu-img", ["info", "--output=json", "-f", "qcow2", image.path], (stdout, stderr) => {
      stdout.setEncoding("utf8");
      stdout.on("data", (part: string) => {
        if (imageInfo.length < 128 * 1024) imageInfo += part;
      });
      stderr.pipe(process.stderr, { end: false });
    });
    const info: unknown = JSON.parse(imageInfo);
    if (!isRecord(info) || info.format !== "qcow2" || "backing-filename" in info)
      throw new Error("Use a standalone qcow2 Windows guest image");
    const format = info["format-specific"];
    if (isRecord(format) && isRecord(format.data) && "data-file" in format.data)
      throw new Error("The Windows guest base must contain its own disk data");
    await execute("qemu-img", ["create", "-f", "qcow2", "-F", "qcow2", "-b", image.path, overlay]);
    await execute("virt-customize", [
      "--quiet",
      "--no-network",
      "--format=qcow2",
      "-a",
      overlay,
      "--copy-in",
      `${payload}:/`,
      "--firstboot",
      firstBoot,
    ]);

    const proof = new AbortController();
    const checks = { system: false, user: false, completed: false, failure: "" };
    const result = await run(
      "qemu-system-x86_64",
      [
        "-machine",
        "q35,accel=kvm",
        "-cpu",
        "host",
        "-smp",
        String(Math.min(4, availableParallelism())),
        "-m",
        "6144",
        ...boot,
        "-drive",
        "file=guest.qcow2,format=qcow2,if=ide",
        "-nic",
        "none",
        "-display",
        "none",
        "-monitor",
        "none",
        "-serial",
        "stdio",
      ],
      (stdout, stderr) => {
        stderr.pipe(process.stderr, { end: false });
        createInterface({ input: stdout, crlfDelay: Infinity }).on("line", (line) => {
          if (line.startsWith("WB-TEST The shared Workbench service is registered"))
            console.log("Windows guest is rebooting to verify shared service startup.");
          else if (line.startsWith("WB-TEST Removed the system registration."))
            console.log("Windows guest is rebooting to install the private service.");
          else if (line.startsWith("WB-TEST The private Workbench service is registered"))
            console.log("Windows guest is rebooting to verify ordinary-user sign-in.");
          else if (line.startsWith("WB-TEST PASS SCM automatically started ")) checks.system = true;
          else if (line.startsWith("WB-TEST PASS Task Scheduler automatically started ")) checks.user = checks.system;
          else if (line === "WB-TEST PASS BOTH WINDOWS STARTUP CHECKS") {
            checks.completed = checks.system && checks.user;
            proof.abort();
          } else if (!checks.failure && line.startsWith("WB-TEST FAIL ")) {
            const fault =
              /^WB-TEST FAIL (prepare|startup|bootstrap)(?: (\d{1,5})(?: ([A-Za-z][A-Za-z0-9]{1,80}))?)?\b/.exec(line);
            checks.failure = fault?.[1] ?? "unknown";
            if (fault?.[2] && fault[2] !== "0") checks.failure += ` at verifier line ${fault[2]}`;
            if (fault?.[3]) checks.failure += ` (${fault[3]})`;
            proof.abort();
          }
        });
      },
      AbortSignal.any([signal, proof.signal]),
    );
    signal.throwIfAborted();
    if (!checks.completed || checks.failure)
      throw new Error(
        `Windows guest ${checks.failure ? `failed during ${checks.failure}` : "did not report completion"} ` +
          `(SCM: ${checks.system ? "passed" : "unverified"}, Task Scheduler: ${checks.user ? "passed" : "unverified"})`,
        checks.failure ? {} : { cause: processFailure("Windows guest", result) },
      );
    console.log("PASS Windows SCM started the shared service before sign-in.");
    console.log("PASS Windows Task Scheduler started the private service at ordinary-user sign-in.");
  } catch (error) {
    try {
      scratch.release();
    } catch (cleanup) {
      throw combineFailures(error, cleanup, "Windows startup check and guest cleanup both failed");
    }
    throw error;
  }
  scratch.release();
}

if (isMainScript(import.meta.url)) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Windows startup qualification requires Linux x64 with KVM");
  const fixture = inputs();
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch (cause) {
    throw new Error("Windows startup qualification requires read and write access to /dev/kvm", { cause });
  }
  const cancellation = processCancellation();
  const deadline = AbortSignal.timeout(deadlineMs);
  try {
    await runWindowsStartup(fixture, AbortSignal.any([cancellation.signal, deadline]));
  } catch (error) {
    if (deadline.aborted) throw new Error("Windows startup qualification exceeded 20 minutes", { cause: error });
    throw error;
  } finally {
    cancellation.close();
  }
}
