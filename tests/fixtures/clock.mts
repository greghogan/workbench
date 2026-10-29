import { vi } from "vitest";

/** Retry tests control Node's promise timers as well as global timers. */
export function fakeClock(): void {
  vi.useFakeTimers({ fakeNodeBuiltins: true });
}
export function realClock(): void {
  vi.useRealTimers();
}
