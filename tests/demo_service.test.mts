import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ChildOutcome, OwnedChildOptions } from "../scripts/owned-child.mjs";
import { startDemonstrationService } from "../src/web/demo-service.ts";

const children = vi.hoisted(() => [] as { stop: () => void }[]);
vi.mock("../scripts/owned-child.mjs", () => ({
  runOwnedChild: (_command: string, _args: string[], options: OwnedChildOptions) =>
    new Promise<ChildOutcome>((resolve) => {
      const output = new PassThrough(),
        errors = new PassThrough();
      const stop = () => {
        resolve({ pid: 1, status: 1, signal: null });
      };
      children.push({ stop });
      options.signal.addEventListener("abort", stop, { once: true });
      options.output?.(output, errors);
      const directory = options.env.WORKBENCH_DEMONSTRATION_CHILD;
      if (!directory) throw new Error("Missing owned demonstration directory");
      queueMicrotask(() =>
        output.write(
          "WORKBENCH_DEMO_READY " +
            JSON.stringify({
              kind: "workbench-demo-ready",
              url: "http://127.0.0.1:12345",
              root: join(directory, "project"),
              source: join(directory, "collection"),
            }) +
            "\n",
        ),
      );
    }),
}));
afterEach(() => children.splice(0));

test("an exited demonstration becomes unavailable and concurrent recovery preserves its owned files", async () => {
  const service = await startDemonstrationService(import.meta.dirname);
  try {
    mkdirSync(service.root);
    const file = join(service.root, "human-edit.md");
    writeFileSync(file, "Keep this edit.\n");
    expect(service.available).toBe(true);
    children[0]?.stop();
    await vi.waitFor(() => {
      expect(service.available).toBe(false);
    });
    await Promise.all([service.restart(), service.restart()]);
    expect(service.available).toBe(true);
    expect(children).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe("Keep this edit.\n");
  } finally {
    await service.close();
  }
  expect(existsSync(service.root)).toBe(false);
  await expect(service.restart()).rejects.toMatchObject({ status: 503 });
});
