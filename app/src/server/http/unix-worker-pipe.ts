import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import type { MachineLease } from "../../core/execution/checks/machine-admission.js";

const token = 0x2b;
const buffer = Buffer.alloc(1, token);

/** One pipe belongs to one job. Every byte issued is backed by a reservation in the machine pool. */
export class UnixWorkerPipe {
  private reserved = 0;
  private readonly descriptor: number;

  constructor(
    path: string,
    uid: number,
    private readonly maximum: number,
    private readonly lease: MachineLease,
  ) {
    const descriptor = openSync(path, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const status = fstatSync(descriptor);
      if (!status.isFIFO() || status.uid !== uid || (status.mode & 0o777) !== 0o600)
        throw new Error("The worker pipe is not owned by its authenticated job");
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
    this.descriptor = descriptor;
  }

  supply(maximum: number): number {
    const available = Math.min(maximum, this.maximum - this.reserved);
    if (!available) return 0;
    const count = this.lease.reserveWorkers(available);
    if (!count) return 0;
    let written = 0;
    try {
      written = writeSync(this.descriptor, Buffer.alloc(count, token));
      this.reserved += written;
      return written;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      return 0;
    } finally {
      if (written < count) this.lease.returnWorkers(count - written);
    }
  }

  withdraw(): void {
    if (!this.reserved) return;
    try {
      if (!readSync(this.descriptor, buffer, 0, 1, null)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") return;
      throw error;
    }
    if (buffer[0] !== token) throw new Error("The worker pipe returned an unknown token");
    this.reserved--;
    this.lease.returnWorkers(1);
  }

  close(): void {
    closeSync(this.descriptor);
  }
}
