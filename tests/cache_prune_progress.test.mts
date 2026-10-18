import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { expect, test, vi, afterEach } from "vitest";
import { CachePruneProgress, pruneItem } from "../src/cache-prune-progress.ts";

function terminal(isTTY = true, columns = 120) {
  const frames: string[] = [];
  return { frames, isTTY, columns, write: (text: string) => frames.push(text) };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("terminal progress advances its spinner during removal and counts only completed items", async () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const output = terminal();
  let clock = 0;
  const progress = new CachePruneProgress(output, () => clock);
  progress.begin(2);
  const gate = Promise.withResolvers<undefined>();
  const removal = pruneItem("project / ruby / dependencies", () => gate.promise, progress);
  const first = output.frames.at(-1);
  clock = 1000;
  await vi.advanceTimersByTimeAsync(100);
  expect(output.frames.at(-1)).not.toBe(first);
  expect(output.frames.at(-1)).toContain("0/2 cache items (1.0 s): project / ruby / dependencies");
  gate.resolve(undefined);
  await removal;
  expect(output.frames.at(-1)).toContain("1/2 cache items");
  await pruneItem(
    "Tools / node / node 26",
    () => {
      return promised(() => undefined);
    },
    progress,
  );
  progress.close(true);
  expect(output.frames.at(-1)).toBe("Removed 2/2 cache items in 1.0 s.\n");
  const length = output.frames.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(output.frames).toHaveLength(length);
});

test.each([false, true])(
  "redirected or dumb-terminal output has only start and completion summaries (%s)",
  async (dumb) => {
    vi.stubEnv("TERM", dumb ? "dumb" : "xterm");
    const output = terminal(dumb);
    const progress = new CachePruneProgress(output, () => 0);
    progress.begin(1);
    await pruneItem(
      "project",
      () => {
        return promised(() => undefined);
      },
      progress,
    );
    progress.close(true);
    expect(output.frames).toEqual(["Deleting 1 cache items…\n", "Removed 1/1 cache items in 0.0 s.\n"]);
  },
);

test("partial failure preserves the completion count, clears the terminal line, and stops updates", async () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const output = terminal();
  const progress = new CachePruneProgress(output, () => 0);
  progress.begin(2);
  await pruneItem(
    "first",
    () => {
      return promised(() => undefined);
    },
    progress,
  );
  await expect(
    pruneItem(
      "second",
      () => {
        return promised(() => {
          throw new Error("cannot remove");
        });
      },
      progress,
    ),
  ).rejects.toThrow("cannot remove");
  progress.close(false);
  expect(output.frames.slice(-2)).toEqual(["\r\u001b[2K", "Stopped after removing 1/2 cache items in 0.0 s.\n"]);
  const length = output.frames.length;
  await vi.advanceTimersByTimeAsync(1000);
  progress.close(false);
  expect(output.frames).toHaveLength(length);
});

test("paths are sanitized and kept within one terminal row; unstarted cleanup emits nothing", () => {
  vi.stubEnv("TERM", "xterm");
  const output = terminal(true, 60);
  const progress = new CachePruneProgress(output, () => 0);
  progress.close(false);
  expect(output.frames).toEqual([]);
  progress.begin(1);
  progress.start("\u001b[31mline\n\t" + "界".repeat(100));
  const row = required(output.frames.at(-1), "Fixture value output.frames.at(-1)").replace("\r\u001b[2K", "");
  expect(row).not.toContain("\u001b");
  expect(row).not.toMatch(/[\n\t]/);
  expect(Buffer.byteLength(row)).toBeLessThan(60);
  progress.close(true);
});
