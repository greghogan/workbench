import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { finalizeImage } from "../src/image-finalization.ts";
const state = vi.hoisted((): { calls: string[][]; fail: string | string[]; config: { Cmd?: string[] } } => ({
  calls: [] as string[][],
  fail: "",
  config: { Cmd: ["original", "argument"] },
}));
vi.mock("../src/ci-lifecycle.js", () => ({
  CILifecycle: class {
    checkpoint() {
      return Promise.resolve();
    }
    close() {
      return;
    }
  },
  executeCI: vi.fn<typeof import("../src/ci-lifecycle.js").executeCI>((_command, args) =>
    promised(() => {
      state.calls.push(args);
      if ([state.fail].flat().includes(args[0] ?? "")) throw new Error("selected finalization failure");
      if (args[0] === "cp" && args[1] === "--follow-link")
        writeFileSync(required(args.at(-1), "Copy destination"), "account", { mode: 0o444 });
      return args[0] === "image" ? JSON.stringify(state.config) : "";
    }),
  ),
}));
afterEach(() => {
  state.calls = [];
  state.fail = "";
  state.config = { Cmd: ["original", "argument"] };
});
test("image finalization preserves the original command and applies labels without starting or building", async () => {
  await finalizeImage("source:image", "target:image", {
    "org.workbench.inputs": "pinned",
    "org.example.description": 'quoted " label',
  });
  const create = state.calls.find((args) => args[0] === "create");
  const commit = state.calls.find((args) => args[0] === "commit");
  expect(commit).toContain('CMD ["original","argument"]');
  expect(create).toContain("org.workbench.inputs=pinned");
  expect(create).toContain('org.example.description=quoted " label');
  expect(required(commit, "Expected fixture value: commit").slice(-2)).toEqual([
    required(create, "Expected fixture value: create")[
      required(create, "Expected fixture value: create").indexOf("--name") + 1
    ],
    "target:image",
  ]);
  expect(state.calls.some((args) => ["start", "run", "build"].includes(args[0] ?? ""))).toBe(false);
  expect(state.calls.at(-1)).toEqual([
    "rm",
    "--force",
    "--volumes",
    required(commit, "Expected fixture value: commit").at(-2),
  ]);
});
test("only declared account files are copied, following source links and replacing destinations", async () => {
  await finalizeImage("source:image", "target:image", {}, ["/etc/passwd", "/etc/group"]);
  const copies = state.calls.filter((args) => args[0] === "cp");
  expect(copies).toHaveLength(4);
  for (const [source, destination] of [
    [copies[0], copies[1]],
    [copies[2], copies[3]],
  ] as const) {
    expect(required(source, "Expected fixture value: source")[1]).toBe("--follow-link");
    expect(required(source, "Expected fixture value: source").at(-1)).toBe(
      required(destination, "Expected fixture value: destination")[1],
    );
    expect(required(destination, "Expected fixture value: destination").at(-1)).toMatch(/:\/etc\/$/);
    expect(existsSync(required(required(source, "Expected fixture value: source").at(-1), "Copy destination"))).toBe(
      false,
    );
  }
});
test.each(["image", "create", "cp", "commit", "rm"])(
  "failure during %s cleans owned scratch and the never-started container",
  async (failure) => {
    state.fail = failure;
    await expect(finalizeImage("source:image", "target:image", {}, ["/etc/passwd"])).rejects.toThrow(
      /selected finalization failure/,
    );
    const copies = state.calls.filter((args) => args[0] === "cp");
    for (const args of copies) expect(existsSync(required(args.at(-1), "Copy destination"))).toBe(false);
    if (!["image", "create"].includes(failure))
      expect(required(state.calls.at(-1), "Expected fixture value: state.calls.at(-1)")[0]).toBe("rm");
    else expect(state.calls.some((args) => args[0] === "rm")).toBe(false);
  },
);
test("images without a default command and invalid materialization requests are explicit", async () => {
  state.config = {};
  await finalizeImage("source:image", "target:image");
  expect(state.calls.find((args) => args[0] === "commit")).toContain("CMD []");
  state.calls = [];
  await expect(finalizeImage("source:image", "target:image", {}, ["/etc/shadow"])).rejects.toThrow(/declared/);
  await expect(finalizeImage("source:image", "target:image", { "bad label": "x" })).rejects.toThrow(/label name/);
  expect(state.calls).toEqual([]);
});

test("finalization and cleanup failures both retain their causes", async () => {
  state.fail = ["commit", "rm"];
  await expect(finalizeImage("source:image", "target:image")).rejects.toMatchObject({
    errors: [expect.any(Error), expect.any(Error)],
  });
});
