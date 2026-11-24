import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, loadavg } from "node:os";
import type { HostActivity } from "./machine-admission.js";

interface CpuTimes {
  idle: number;
  total: number;
}

const fullyBusy = 0.95;
const busyWithContention = 0.8;
const sustainedCpuStallPercent = 25;
const sustainedMemoryStallPercent = 1;

function runnableWorkContends(): boolean {
  return process.platform !== "win32" && (loadavg()[0] ?? 0) > availableParallelism();
}

async function kernelText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function linuxTimes(stat: string): CpuTimes | undefined {
  const line = /^cpu +([0-9 ]+)$/m.exec(stat)?.[1];
  if (!line) return undefined;
  // Guest counters are already included in user and nice time.
  const ticks = line.trim().split(/ +/).slice(0, 8).map(Number);
  return {
    idle: (ticks[3] ?? 0) + (ticks[4] ?? 0),
    total: ticks.reduce((total, next) => total + next, 0),
  };
}

function stallPercent(content: string, scope: "some" | "full"): number {
  const value = new RegExp(`^${scope} avg10=([0-9.]+) `, "m").exec(content)?.[1];
  return value === undefined ? 0 : Number(value);
}

export class HostActivitySampler {
  private previous: CpuTimes | undefined;

  private utilization(current: CpuTimes | undefined): number | undefined {
    const previous = this.previous;
    this.previous = current;
    if (!current || !previous) return undefined;
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    return total > 0 && idle >= 0 && idle <= total ? (total - idle) / total : undefined;
  }

  async sample(): Promise<HostActivity> {
    if (process.platform !== "linux") {
      const processors = cpus();
      const current = processors.reduce(
        ({ idle, total }, { times }) => ({
          idle: idle + times.idle,
          total: total + times.user + times.nice + times.sys + times.idle + times.irq,
        }),
        { idle: 0, total: 0 },
      );
      const busy = this.utilization(processors.length ? current : undefined);
      return {
        availableMemory: freemem(),
        ...(busy === undefined
          ? {}
          : { cpuSaturated: busy >= fullyBusy || (busy >= busyWithContention && runnableWorkContends()) }),
      };
    }
    const [stat, memory, cpuPressure, memoryPressure] = await Promise.all([
      kernelText("/proc/stat"),
      kernelText("/proc/meminfo"),
      kernelText("/proc/pressure/cpu"),
      kernelText("/proc/pressure/memory"),
    ]);
    const busy = this.utilization(linuxTimes(stat));
    const available = /^MemAvailable:\s*(\d+) kB$/m.exec(memory)?.[1];
    return {
      ...(available === undefined ? {} : { availableMemory: Number(available) * 1024 }),
      ...(busy === undefined
        ? {}
        : {
            cpuSaturated:
              busy >= fullyBusy ||
              (busy >= busyWithContention &&
                (cpuPressure ? stallPercent(cpuPressure, "some") >= sustainedCpuStallPercent : runnableWorkContends())),
          }),
      memoryPressure: stallPercent(memoryPressure, "full") >= sustainedMemoryStallPercent,
    };
  }
}
