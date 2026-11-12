export type BlockPair<T> = [T | undefined, T | undefined];
const Step = { Match: 1, Remove: 2, Add: 3 } as const;
const minimumSimilarity = 0.35;
const replacementWeight = 3;

function cell(values: Float64Array | Uint8Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error("Block alignment matrix index is invalid");
  return value;
}

/** Weighted global sequence alignment: unit gaps and similarity-weighted substitutions, with monotone matches. */
export function alignBlocks<T>(
  before: readonly T[],
  after: readonly T[],
  similarity: (before: T, after: T) => number | undefined,
  limits: { available: () => boolean; maxCells: number },
): BlockPair<T>[] | undefined {
  if (!before.length) return after.map((value) => [undefined, value]);
  if (!after.length) return before.map((value) => [value, undefined]);
  const width = after.length + 1;
  const cells = (before.length + 1) * width;
  if (cells > limits.maxCells || !limits.available()) return undefined;
  const costs = new Float64Array(cells),
    steps = new Uint8Array(cells);
  for (let i = 1; i <= before.length; i++) {
    costs[i * width] = i;
    steps[i * width] = Step.Remove;
  }
  for (let j = 1; j <= after.length; j++) {
    costs[j] = j;
    steps[j] = Step.Add;
  }
  for (let i = 1; i <= before.length; i++) {
    const previous = before[i - 1];
    if (previous === undefined) throw new Error("Block alignment requires dense input sequences");
    for (let j = 1; j <= after.length; j++) {
      if (!limits.available()) return undefined;
      const current = after[j - 1];
      if (current === undefined) throw new Error("Block alignment requires dense input sequences");
      const at = i * width + j;
      const remove = cell(costs, at - width) + 1,
        add = cell(costs, at - 1) + 1;
      costs[at] = Math.min(remove, add);
      // Backtracking additions first places removals before additions when costs tie.
      steps[at] = remove < add ? Step.Remove : Step.Add;
      const score = similarity(previous, current);
      if (score === undefined || !(score >= minimumSimilarity && score <= 1)) continue;
      const replace = cell(costs, at - width - 1) + replacementWeight * (1 - score);
      if (replace < cell(costs, at)) {
        costs[at] = replace;
        steps[at] = Step.Match;
      }
    }
  }
  if (!limits.available()) return undefined;
  const result: BlockPair<T>[] = [];
  let i = before.length,
    j = after.length;
  while (i || j) {
    const step = cell(steps, i * width + j);
    if (step === Step.Match) result.push([before[--i], after[--j]]);
    else if (step === Step.Remove) result.push([before[--i], undefined]);
    else if (step === Step.Add) result.push([undefined, after[--j]]);
    else throw new Error("Block alignment traceback is invalid");
  }
  return result.reverse();
}
