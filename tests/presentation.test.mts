import { afterEach, expect, test, vi } from "vitest";
import { configurePresentation, colorDisabled, plainOutput } from "../src/presentation.ts";
import { CheckProgress } from "../src/check-progress.ts";
import { CachePruneProgress } from "../src/cache-prune-progress.ts";
import { terminalTable } from "../src/terminal-table.ts";
import { chooseItems } from "../src/terminal-choice.ts";
import { terminal } from "./fixtures/terminal.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

test.each([
  [undefined, undefined, false, false],
  [undefined, undefined, true, true],
  [undefined, "", true, true],
  [undefined, "1", false, true],
  [undefined, "true", false, true],
  [undefined, "0", true, false],
  [undefined, "false", true, false],
  [true, "0", false, true],
  [false, "1", true, false],
] as const)("plain precedence: flag %s, environment %s, saved %s", (flag, environment, saved, expected) => {
  vi.stubEnv("WORKBENCH_PLAIN", environment);
  configurePresentation(flag, saved);
  expect(plainOutput()).toBe(expected);
  expect(process.env.WORKBENCH_PLAIN).toBe(expected ? "1" : "0");
});

test("invalid inherited presentation is rejected unless an explicit flag overrides it", () => {
  vi.stubEnv("WORKBENCH_PLAIN", "maybe");
  expect(() => {
    configurePresentation(undefined, false);
  }).toThrow(/WORKBENCH_PLAIN/);
  configurePresentation(false, true);
  expect(plainOutput()).toBe(false);
});

test.each([undefined, "", "1", "0"])("NO_COLOR=%s controls color independently of plain", (value) => {
  vi.stubEnv("WORKBENCH_PLAIN", "0");
  vi.stubEnv("NO_COLOR", value);
  expect(colorDisabled()).toBe(!!value);
  expect(plainOutput()).toBe(false);
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  expect(colorDisabled()).toBe(true);
});

test("plain progress on a TTY emits complete stable messages and schedules no spinner", () => {
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  vi.stubEnv("TERM", "xterm");
  const chunks: string[] = [];
  const output = { isTTY: true, columns: 8, rows: 5, write: (value: string) => chunks.push(value) };
  const checks = new CheckProgress(1, output);
  checks.message("\u001b[31mDiagnostic text\u001b[0m");
  checks.startGroup("one", "Long language label");
  checks.event("one", "Long language label", 1, "Full check name", "pass");
  checks.finishGroup("one", "Long language label", false);
  checks.close(true);
  const deletion = new CachePruneProgress(output, () => 0);
  deletion.begin(1);
  deletion.start("Full item name");
  deletion.complete();
  deletion.close(true);
  expect(chunks.join("")).not.toContain("\u001b");
  expect(chunks.join("")).not.toContain("\r");
  expect(chunks.join("")).toContain("Diagnostic text\n");
  expect(chunks.join("")).not.toContain("[31m");
  expect(chunks.join("")).toContain("Passed Long language label: Full check name");
  expect(chunks.join("")).toContain("Removed 1/1 cache items");
});

test("plain tables retain complete labeled content regardless of visual column widths", () => {
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  expect(
    terminalTable(["NAME", "VALUE"], [["first", "\u001b[31mLong Unicode value 🧑‍💻\u001b[0m"]], { maxWidths: { 1: 1 } }),
  ).toBe("NAME: first\nVALUE: Long Unicode value 🧑‍💻");
  expect(terminalTable(["NAME"], [])).toContain("No entries.");
});

test("plain selection supports complete hierarchical labels, dynamic protection, invalid input and explicit confirmation", async () => {
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  const screen = terminal(8, 5);
  const result = chooseItems(
    "Remove selected items",
    [
      { name: "project", label: "Very long project name 🧑‍💻" },
      {
        name: "tools",
        children: [
          { name: "runtime", disabled: (selected) => !selected.has("project"), reason: "Requires project removal" },
          { name: "protected", disabled: () => true, reason: "Active work" },
        ],
      },
    ],
    [],
    screen.input,
    screen.output,
    (selected) => `Delete: ${selected.join(", ")}`,
  );
  screen.input.write("99\nall\n\nyes\n");
  await expect(result).resolves.toEqual(["project", "runtime"]);
  expect(screen.text()).toContain("Very long project name 🧑‍💻");
  expect(screen.text()).toContain("tools / runtime: disabled (Requires project removal)");
  expect(screen.text()).toContain("Invalid selection");
  expect(screen.text()).toContain("Delete: project, runtime");
  expect(screen.text()).not.toContain("\u001b");
  expect(screen.text()).not.toContain("\r");
  expect(screen.input.isRaw).toBe(false);
  expect(screen.input.listenerCount("data")).toBe(0);
});

test.each(["cancel\n", "all\n\nno\n", ""])(
  "plain cancellation, declined deletion and EOF preserve caller selection (%j)",
  async (answer) => {
    vi.stubEnv("WORKBENCH_PLAIN", "1");
    const screen = terminal();
    const enabled = ["first"];
    const result = chooseItems(
      "Remove",
      [{ name: "first" }],
      enabled,
      screen.input,
      screen.output,
      () => "Delete first?",
    );
    screen.input.end(answer);
    await expect(result).resolves.toBeUndefined();
    expect(enabled).toEqual(["first"]);
    expect(screen.input.isRaw).toBe(false);
  },
);

test("plain toggles use stable numbers, normalize protected selections, and sanitize control sequences", async () => {
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  const screen = terminal();
  const result = chooseItems(
    "Title",
    [{ name: "one", label: "one\u001b[2J" }, { name: "two" }],
    [],
    screen.input,
    screen.output,
  );
  screen.input.write("1, 2\nnone\n2\n\n");
  await expect(result).resolves.toEqual(["two"]);
  expect(screen.text()).not.toContain("\u001b");
});

test("plain mode keeps the terminal requirement and safely cancels on SIGINT", async () => {
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  const screen = terminal();
  screen.input.isTTY = false;
  expect(() => chooseItems("Choose", [], [], screen.input, screen.output)).toThrow(/needs a terminal/);
  screen.input.isTTY = true;
  const before = process.listenerCount("SIGINT");
  const result = chooseItems("Choose", [{ name: "one" }], [], screen.input, screen.output);
  process.emit("SIGINT");
  await expect(result).resolves.toBeUndefined();
  expect(process.listenerCount("SIGINT")).toBe(before);
});

test.each(["error", "close", "SIGTERM"])("plain selection releases listeners after %s", async (event) => {
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  const screen = terminal();
  const before = process.listenerCount("SIGTERM");
  const result = chooseItems("Choose", [{ name: "one" }], [], screen.input, screen.output);
  if (event === "SIGTERM") process.emit("SIGTERM");
  else if (event === "error") screen.output.emit("error", new Error("failed output"));
  else screen.output.emit("close");
  await expect(result).rejects.toThrow(
    event === "SIGTERM" ? /interrupted/ : event === "error" ? /failed output/ : /output closed/,
  );
  expect(process.listenerCount("SIGTERM")).toBe(before);
  expect(screen.input.isRaw).toBe(false);
  expect(screen.output.listenerCount("error")).toBe(0);
});

test("NO_COLOR alone preserves interactive navigation, and an empty plain selection needs no deletion confirmation", async () => {
  vi.stubEnv("WORKBENCH_PLAIN", "0");
  vi.stubEnv("NO_COLOR", "1");
  const screen = terminal();
  const rich = chooseItems("Choose", [{ name: "one" }], ["one"], screen.input, screen.output);
  expect(screen.input.isRaw).toBe(true);
  screen.key("return");
  await expect(rich).resolves.toEqual(["one"]);
  vi.stubEnv("WORKBENCH_PLAIN", "1");
  const plain = terminal();
  const result = chooseItems("Remove", [{ name: "one" }], [], plain.input, plain.output, () => "Delete?");
  plain.input.write("\n");
  await expect(result).resolves.toEqual([]);
  expect(plain.text()).not.toContain("Delete?");
});
