import { afterEach, expect, test, vi } from "vitest";
import { pageHelp, helpLines } from "../src/help-pager.ts";
import { terminal } from "./fixtures/terminal.mjs";
afterEach(() => vi.unstubAllEnvs());
test("long help pages in a terminal, responds to navigation and restores terminal state", async () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("WORKBENCH_PLAIN", undefined);
  const t = terminal(80, 4);
  const promise = pageHelp("one\ntwo\nthree\nfour\nfive\nsix\n", false, t.input, t.output);
  expect(t.input.isRaw).toBe(true);
  expect(t.text()).toContain("one\ntwo\nthree");
  t.key("space");
  expect(t.text()).toContain("four\nfive\nsix");
  t.key("pageup");
  t.key("end");
  t.output.emit("resize");
  t.key("q");
  await promise;
  expect(t.input.isRaw).toBe(false);
  expect(t.input.isPaused()).toBe(true);
  expect(t.text()).toContain("\u001b[?25h\u001b[?1049l");
  expect(t.input.listenerCount("keypress")).toBe(0);
});
test("short, disabled and nonterminal help remain ordinary output; EOF cleans a pager", async () => {
  vi.stubEnv("TERM", "xterm");
  const t = terminal(80, 4);
  await pageHelp("short\n", false, t.input, t.output);
  expect(t.text()).toBe("short\n");
  await pageHelp("1\n2\n3\n4\n5\n", true, t.input, t.output);
  expect(t.input.isRaw).toBe(false);
  const long = pageHelp("1\n2\n3\n4\n5\n", false, t.input, t.output);
  t.input.emit("end");
  await long;
  expect(t.input.isRaw).toBe(false);
  expect(helpLines("a\u001b[31mb\u001b[0m\n👩‍💻", 2).join("\n")).not.toContain("\u001b");
});

test("paging reuses wrapped help until terminal width changes", async () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("WORKBENCH_PLAIN", undefined);
  const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
  const t = terminal(80, 4),
    paging = pageHelp("1\n2\n3\n4\n5\n6\n", false, t.input, t.output);
  const wraps = () => segment.mock.calls.filter(([text]) => text === "1").length;
  const initial = wraps();
  t.key("down");
  t.key("pageup");
  t.key("end");
  expect(wraps()).toBe(initial);
  t.output.columns = 60;
  t.output.emit("resize");
  expect(wraps()).toBeGreaterThan(initial);
  t.key("q");
  await paging;
  segment.mockRestore();
});
