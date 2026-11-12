export interface ComparisonBudget {
  now: () => number;
  milliseconds: number;
  maxEdits: number;
  maxWords?: number;
  maxAlignmentCells?: number;
}

/** One fine-comparison allowance covers the body and every metadata field; fallback remains complete. */
export class ComparisonWork {
  readonly maxEdits: number;
  readonly maxWords: number;
  readonly maxAlignmentCells: number;
  private readonly deadline: number;
  private readonly now: () => number;
  constructor(budget: ComparisonBudget = { now: () => performance.now(), milliseconds: 60, maxEdits: 2048 }) {
    this.now = budget.now;
    this.deadline = budget.now() + budget.milliseconds;
    this.maxEdits = budget.maxEdits;
    this.maxWords = budget.maxWords ?? 20000;
    this.maxAlignmentCells = budget.maxAlignmentCells ?? 8192;
  }
  remaining(): number {
    return Math.max(0, this.deadline - this.now());
  }
  available(): boolean {
    return this.remaining() > 0;
  }
}
