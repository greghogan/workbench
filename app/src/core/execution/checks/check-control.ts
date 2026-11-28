import { CheckEvent, hasEnumValue } from "../../diagnostics/diagnostic-contract.mjs";
export const checkControlPrefix = "WORKBENCH_CHECK_CONTROL\t";

export function validateCheckControl(token: string): void {
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("invalid private check control token");
}

/** Contiguous opted-in checks may overlap. Every other check is a barrier. */
export function checkBatches<T extends { parallel?: boolean; role?: string; name?: string }>(
  checks: readonly T[],
  limit = 1,
  privateChecks: ReadonlySet<string> = new Set(),
): T[][] {
  const concurrent = (check: T) =>
    check.parallel && (!(check.role === "test" || check.role === "coverage") || privateChecks.has(check.name ?? ""));
  const batches: T[][] = [];
  for (const check of checks) {
    const batch = batches.at(-1);
    if (limit > 1 && concurrent(check) && batch?.[0] && concurrent(batch[0])) batch.push(check);
    else batches.push([check]);
  }
  return batches;
}

/** Accept each start and finish once, within the admitted batch. */
export class CheckControl {
  private wave = 0;
  private first = 1;
  private readonly running = new Set<number>();
  private readonly finished = new Set<number>();
  private failed = false;
  constructor(
    private readonly token: string,
    total: number,
    private readonly widths = Array<number>(total).fill(1),
    private readonly limit = Math.max(1, ...widths),
  ) {
    validateCheckControl(token);
  }
  accept(line: string): { event: CheckEvent; step: number } | undefined {
    if (!line.startsWith(`${checkControlPrefix}${this.token}\t`)) return;
    const parts = line.split("\t");
    const event = parts[2];
    const step = Number(parts[3]);
    const width = this.widths[this.wave] ?? 0;
    if (
      parts.length !== 4 ||
      !Number.isSafeInteger(step) ||
      String(step) !== parts[3] ||
      step < this.first ||
      step >= this.first + width ||
      this.finished.has(step) ||
      !hasEnumValue(CheckEvent, event) ||
      (event === CheckEvent.Start ? this.running.has(step) || this.running.size >= this.limit : !this.running.has(step))
    )
      throw new Error("invalid check control sequence");
    if (event === CheckEvent.Start) this.running.add(step);
    else {
      this.running.delete(step);
      this.finished.add(step);
      this.failed ||= event === CheckEvent.Fail;
      if (!this.failed && this.finished.size === width) {
        this.first += width;
        this.wave++;
        this.finished.clear();
      }
    }
    return { event, step };
  }
  get complete(): boolean {
    return !this.failed && this.wave === this.widths.length;
  }
}
