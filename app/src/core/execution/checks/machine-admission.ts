import { availableParallelism, totalmem } from "node:os";
import type { userConfigValues } from "../../configuration/user-config.js";
import { errorFrom } from "../../runtime/values.mjs";
import { positiveInteger } from "./cpu-budget.mjs";
import type { WorkLease } from "./work-admission.mjs";

export interface HostActivity {
  cpuSaturated?: boolean;
  availableMemory?: number;
  memoryPressure?: boolean;
}

interface AdmissionLimits {
  maxJobs: number;
  workerSlots: number;
  memoryReserve: number;
  settlingMs: number;
}

type WaitReason = "job limit" | "worker slots" | "memory pressure" | "CPU saturation" | "job startup";

interface WaitingJob {
  resolve: (lease: MachineLease) => void;
  reject: (reason: unknown) => void;
  unsubscribe: () => void;
}

const maximumWaitingJobs = 4096;
const recoverySamples = 2;

export type MachineLease = WorkLease;

/** The transport authenticates callers and releases a lease after its owned processes finish. */
export class MachineAdmission {
  private readonly queues = new Map<string, Set<WaitingJob>>();
  private lastProject: string | undefined;
  private waiting = 0;
  private active = 0;
  private closed = false;
  private activity: HostActivity = {};
  private cpuBlocked = false;
  private cpuRecovery = 0;
  private settlingUntil = 0;

  constructor(
    private readonly limits: AdmissionLimits,
    private readonly now = () => performance.now(),
  ) {
    positiveInteger(limits.maxJobs, "machine job limit");
    positiveInteger(limits.workerSlots, "machine worker slots");
    for (const count of [limits.memoryReserve, limits.settlingMs])
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid machine admission limits");
  }

  private blocked(): WaitReason | undefined {
    if (this.active >= this.limits.maxJobs) return "job limit";
    if (this.active >= this.limits.workerSlots) return "worker slots";
    const { availableMemory, memoryPressure } = this.activity;
    if (
      memoryPressure ||
      (availableMemory === undefined ? this.active > 0 : availableMemory < this.limits.memoryReserve)
    )
      return "memory pressure";
    if (this.cpuBlocked) return "CPU saturation";
    if (this.now() < this.settlingUntil) return "job startup";
    return undefined;
  }

  inspect() {
    return {
      active: this.active,
      waiting: this.waiting,
      reason: this.waiting ? this.blocked() : undefined,
    };
  }

  observe(activity: HostActivity): void {
    this.activity = activity;
    if (activity.cpuSaturated) {
      this.cpuBlocked = true;
      this.cpuRecovery = 0;
    } else if (activity.cpuSaturated === undefined || (this.cpuBlocked && ++this.cpuRecovery >= recoverySamples)) {
      this.cpuBlocked = false;
      this.cpuRecovery = 0;
    }
    this.drain();
  }

  async acquire(project: string, signal?: AbortSignal): Promise<MachineLease> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("The machine jobserver stopped accepting work");
    if (this.waiting >= maximumWaitingJobs) throw new Error("The machine jobserver queue is full");
    return new Promise<MachineLease>((resolve, reject) => {
      const queue = this.queues.get(project) ?? new Set<WaitingJob>();
      this.queues.set(project, queue);
      const cancel = () => {
        if (!queue.delete(job)) return;
        this.waiting--;
        if (!queue.size) this.queues.delete(project);
        reject(errorFrom(signal?.reason));
        this.drain();
      };
      const job: WaitingJob = {
        resolve,
        reject,
        unsubscribe: () => signal?.removeEventListener("abort", cancel),
      };
      queue.add(job);
      this.waiting++;
      signal?.addEventListener("abort", cancel, { once: true });
      this.drain();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error("The machine jobserver stopped accepting work");
    for (const queue of this.queues.values()) {
      for (const job of queue) {
        job.unsubscribe();
        job.reject(error);
      }
    }
    this.queues.clear();
    this.waiting = 0;
  }

  private drain(): void {
    while (!this.closed && this.waiting && !this.blocked()) {
      const candidates = this.queues.entries();
      let selected = candidates.next().value;
      if (selected?.[0] === this.lastProject) selected = candidates.next().value ?? selected;
      if (!selected) throw new Error("Machine admission lost its queued projects");
      const [project, queue] = selected;
      const job = queue.values().next().value;
      if (!job) throw new Error("Machine admission lost a queued job");
      this.queues.delete(project);
      queue.delete(job);
      if (queue.size) this.queues.set(project, queue);
      this.waiting--;
      this.lastProject = project;
      this.active++;
      this.settlingUntil = this.now() + this.limits.settlingMs;
      job.unsubscribe();
      let released = false;
      job.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.active--;
          this.drain();
        },
      });
    }
  }
}

export function configuredMachineAdmission(preferences: ReturnType<typeof userConfigValues>): MachineAdmission {
  const cpus = availableParallelism();
  return new MachineAdmission({
    maxJobs: Number(preferences["daemon.job_limit"] ?? cpus),
    workerSlots: Number(preferences["daemon.worker_slots"] ?? cpus),
    memoryReserve: Number(
      preferences["daemon.memory_reserve_bytes"] ?? Math.min(1024 ** 3, Math.floor(totalmem() / 20)),
    ),
    settlingMs: 500,
  });
}
