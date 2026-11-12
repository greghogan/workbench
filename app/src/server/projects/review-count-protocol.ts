export interface ReviewCountUpdate {
  id: string;
  revision: number;
  count?: number;
  problem?: string;
}
export function decodeReviewCount(input: unknown): ReviewCountUpdate {
  if (
    !input ||
    typeof input !== "object" ||
    !("id" in input) ||
    typeof input.id !== "string" ||
    !/^[a-f0-9]{24}$/.test(input.id) ||
    !("revision" in input) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0 ||
    ("count" in input &&
      input.count !== undefined &&
      (!Number.isSafeInteger(input.count) || Number(input.count) < 0)) ||
    ("problem" in input && input.problem !== undefined && typeof input.problem !== "string")
  )
    throw new Error("Invalid review count update");
  return {
    id: input.id,
    revision: Number(input.revision),
    ...("count" in input && input.count !== undefined ? { count: Number(input.count) } : {}),
    ...("problem" in input && typeof input.problem === "string" ? { problem: input.problem } : {}),
  };
}
export function reviewCountLabel(value: { count?: number; problem?: string } | undefined): string {
  return value?.count === undefined
    ? value?.problem
      ? "Unavailable"
      : "…"
    : String(value.count) + (value.problem ? " (stale)" : "");
}
