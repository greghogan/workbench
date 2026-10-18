export const checkControlPrefix = "WORKBENCH_CHECK_CONTROL\t";

export function validateCheckControl(token: string): void {
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("invalid private check control token");
}

/** Accept only this session's ordered wrapper records, never ordinary progress output. */
export class CheckControl {
  private step = 1;
  private running = false;
  private failed = false;
  constructor(
    private readonly token: string,
    private readonly total: number,
  ) {
    validateCheckControl(token);
  }
  accept(line: string): { event: "start" | "pass" | "fail"; step: number } | undefined {
    if (!line.startsWith(`${checkControlPrefix}${this.token}\t`)) return;
    const parts = line.split("\t");
    const event = parts[2],
      step = Number(parts[3]);
    if (
      parts.length !== 4 ||
      !Number.isSafeInteger(step) ||
      String(step) !== parts[3] ||
      step !== this.step ||
      step > this.total ||
      this.failed ||
      (event !== "start" && event !== "pass" && event !== "fail") ||
      (event === "start" ? this.running : !this.running)
    )
      throw new Error("invalid check control sequence");
    if (event === "start") this.running = true;
    else {
      this.running = false;
      this.failed = event === "fail";
      this.step++;
    }
    return { event, step };
  }
  get complete(): boolean {
    return !this.failed && !this.running && this.step === this.total + 1;
  }
}
