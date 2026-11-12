export interface CachePruneObserver {
  begin(total: number): void;
  start(label: string): void;
  complete(): void;
}

/** Notify only around the actual removal, after its ownership preflight has passed. */
export async function pruneItem(
  label: string,
  remove: () => Promise<void>,
  progress?: CachePruneObserver,
): Promise<void> {
  progress?.start(label);
  await remove();
  progress?.complete();
}
