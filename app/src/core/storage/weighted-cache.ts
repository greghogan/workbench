/** Disposable LRU storage. Oversized values remain usable without being retained. */
export class WeightedCache<T> {
  private readonly entries = new Map<string, { value: T; cost: number }>();
  private cost = 0;
  constructor(private readonly maximum: number) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, cost: number): void {
    const old = this.entries.get(key);
    if (old) {
      this.cost -= old.cost;
      this.entries.delete(key);
    }
    cost = Math.max(1, cost);
    if (!Number.isSafeInteger(cost) || cost > this.maximum) return;
    while (this.cost + cost > this.maximum) {
      const first = this.entries.entries().next().value;
      if (!first) break;
      this.cost -= first[1].cost;
      this.entries.delete(first[0]);
    }
    this.entries.set(key, { value, cost });
    this.cost += cost;
  }
}
