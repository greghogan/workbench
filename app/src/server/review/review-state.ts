export const PreparationState = { Required: "required", Unavailable: "unavailable" } as const;
export type ReviewPreparation =
  { state: typeof PreparationState.Required } | { state: typeof PreparationState.Unavailable; problem: string };

export function needsReview(
  change: { path: string; approved: boolean },
  preparation: ReadonlyMap<string, ReviewPreparation>,
): boolean {
  return !change.approved || preparation.has(change.path);
}
