import { expect, test } from "vitest";
import { updateChoice, initialChoice, choiceRows, type ChoiceState, type ChoiceItem } from "../src/choice-tree.ts";

const names = ["first", "second"];
const items = names.map((name) => ({ name }));
const initial = (): ChoiceState => ({ index: 0, selected: new Set(), phase: "selecting", expanded: new Set() });

test("navigation wraps across bulk controls and individual choices without changing the input state", () => {
  const before = initial();
  const previous = updateChoice(before, "previous", items, false);
  expect(previous.index).toBe(3);
  expect(updateChoice(previous, "next", items, false).index).toBe(0);
  expect(before.index).toBe(0);
  expect(before.selected.size).toBe(0);
});

test("bulk and individual toggles produce independent selection sets", () => {
  const before = initial();
  const all = updateChoice(before, "toggle", items, false);
  expect([...all.selected]).toEqual(names);
  expect(before.selected.size).toBe(0);
  const none = updateChoice({ ...all, index: 1 }, "toggle", items, false);
  expect(none.selected.size).toBe(0);
  const one = updateChoice({ ...none, index: 2 }, "toggle", items, false);
  expect([...one.selected]).toEqual(["first"]);
  expect(updateChoice(one, "toggle", items, false).selected.size).toBe(0);
});

test("saving either completes selection or waits for explicit confirmation", () => {
  const before = { ...initial(), selected: new Set(["second", "first"]) };
  expect(updateChoice(before, "save", items, false)).toMatchObject({ phase: "finished", result: names });
  const confirming = updateChoice(before, "save", items, true);
  expect(confirming.phase).toBe("confirming");
  expect(updateChoice(confirming, "confirm", items, true)).toMatchObject({ phase: "finished", result: names });
  for (const action of [undefined, "cancel", "save", "toggle", "next"] as const) {
    const cancelled = updateChoice(confirming, action, items, true);
    expect(cancelled.phase).toBe("finished");
    expect(cancelled.result).toBeUndefined();
  }
});

test("empty selections finish without confirmation and cancellation preserves the prior selection", () => {
  expect(updateChoice(initial(), "save", items, true)).toMatchObject({ phase: "finished", result: [] });
  const state = { ...initial(), selected: new Set(["second"]) };
  const cancelled = updateChoice(state, "cancel", items, true);
  expect(cancelled.result).toBeUndefined();
  expect([...state.selected]).toEqual(["second"]);
  expect(updateChoice(cancelled, "toggle", items, true)).toBe(cancelled);
  expect(updateChoice(state, undefined, items, false)).toBe(state);
  expect(updateChoice(initial(), "previous", [], false).index).toBe(1);
  expect(updateChoice(initial(), "toggle", [], false).selected.size).toBe(0);
});

test("tree navigation opens nested groups and Enter returns one parent at a time", () => {
  const tree: ChoiceItem[] = [{ name: "project", children: [{ name: "nested", children: [{ name: "leaf" }] }] }];
  const before = { ...initialChoice(tree, ["project"]), index: 2 };
  const open = updateChoice(before, "open", tree, true);
  expect(open.index).toBe(3);
  expect(before.expanded.size).toBe(0);
  const deep = updateChoice(open, "open", tree, true);
  expect(choiceRows(tree, deep.expanded).map((row) => row.depth)).toEqual([0, 1, 2]);
  const parent = updateChoice(deep, "save", tree, true);
  expect(parent.phase).toBe("selecting");
  expect(parent.index).toBe(3);
  const top = updateChoice(parent, "save", tree, true);
  expect(top.index).toBe(2);
  expect(top.expanded.size).toBe(0);
  const confirming = updateChoice(top, "save", tree, true);
  expect(updateChoice(confirming, "confirm", tree, true).result).toEqual(["leaf"]);
});

test("tree toggles honor dynamic protection and leave sibling and input selections unchanged", () => {
  const tree: ChoiceItem[] = [
    { name: "project" },
    {
      name: "tools",
      children: [
        { name: "runtime", disabled: (selected) => !selected.has("project") },
        { name: "always-pinned", disabled: () => true },
      ],
    },
  ];
  const before = initialChoice(tree, ["tools"]);
  expect(before.selected.size).toBe(0);
  const all = updateChoice(before, "toggle", tree, true);
  expect([...all.selected]).toEqual(["project", "runtime"]);
  expect(before.selected.size).toBe(0);
  const withoutProject = updateChoice({ ...all, index: 2 }, "toggle", tree, true);
  expect(withoutProject.selected.size).toBe(0);
  const parent = { ...all, index: 3 };
  const child = updateChoice(parent, "open", tree, true);
  const toggled = updateChoice(child, "toggle", tree, true);
  expect([...toggled.selected]).toEqual(["project"]);
  const back = updateChoice(toggled, "parent", tree, true);
  expect(back.index).toBe(3);
  expect(back.expanded.size).toBe(0);
});
