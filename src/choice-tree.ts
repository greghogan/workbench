export interface ChoiceItem {
  name: string;
  label?: string;
  section?: string;
  children?: ChoiceItem[];
  reason?: string | ((selected: ReadonlySet<string>) => string) | undefined;
  disabled?: (selected: ReadonlySet<string>) => boolean;
}
export interface ChoiceRow {
  item: ChoiceItem;
  depth: number;
  parent?: string;
  section?: string;
}
export type ChoiceAction = "previous" | "next" | "toggle" | "save" | "cancel" | "confirm" | "open" | "parent";
export interface ChoiceState {
  index: number;
  selected: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  phase: "selecting" | "confirming" | "finished";
  result?: string[];
}

function normalizeChoice(state: ChoiceState, items: ChoiceItem[]): ChoiceState {
  const selected = new Set(state.selected);
  for (const leaf of items.flatMap(choiceLeaves)) if (leaf.disabled?.(selected)) selected.delete(leaf.name);
  return selected.size === state.selected.size ? state : { ...state, selected };
}

export function initialChoice(items: ChoiceItem[], enabled: string[]): ChoiceState {
  const all = choiceItems(items);
  const selected = new Set(
    enabled.flatMap((name) => {
      const item = all.find((item) => item.name === name);
      return item ? choiceLeaves(item).map((leaf) => leaf.name) : [];
    }),
  );
  return normalizeChoice({ index: 0, selected, expanded: new Set(), phase: "selecting" }, items);
}

/** Navigation and selection have no terminal, process, or filesystem effects. */
export function updateChoice(
  state: ChoiceState,
  action: ChoiceAction | undefined,
  items: ChoiceItem[],
  confirmation: boolean,
): ChoiceState {
  if (state.phase === "finished") return state;
  const finish = (accepted: boolean): ChoiceState => ({
    ...state,
    phase: "finished",
    ...(accepted ? { result: [...state.selected].sort() } : {}),
  });
  if (state.phase === "confirming") return finish(action === "confirm");
  if (action === "cancel") return finish(false);
  const rows = choiceRows(items, state.expanded),
    current = rows[state.index - 2];
  const expanded = new Set(state.expanded);
  if ((action === "parent" || action === "save") && current?.parent) {
    expanded.delete(current.parent);
    return {
      ...state,
      expanded,
      index: choiceRows(items, expanded).findIndex((row) => row.item.name === current.parent) + 2,
    };
  }
  if (action === "save") return confirmation && state.selected.size ? { ...state, phase: "confirming" } : finish(true);
  if (action === "open" || action === "parent") {
    if (current?.item.children?.length) {
      expanded.add(current.item.name);
      return { ...state, expanded, index: state.index + 1 };
    }
    action = "next";
  }
  const count = rows.length + 2;
  if (action === "previous") return { ...state, index: (state.index + count - 1) % count };
  if (action === "next") return { ...state, index: (state.index + 1) % count };
  if (action !== "toggle") return state;
  const selected = new Set(state.selected);
  if (state.index === 0) for (const leaf of items.flatMap(choiceLeaves)) selected.add(leaf.name);
  else if (state.index === 1) selected.clear();
  else if (current && !(current.item.disabled?.(state.selected) ?? false)) {
    const leaves = choiceLeaves(current.item).filter((leaf) => !leaf.disabled?.(selected));
    const remove = leaves.length > 0 && leaves.every((leaf) => selected.has(leaf.name));
    for (const leaf of leaves)
      if (remove) selected.delete(leaf.name);
      else selected.add(leaf.name);
  }
  return normalizeChoice({ ...state, selected }, items);
}
export function choiceLeaves(item: ChoiceItem): ChoiceItem[] {
  return item.children?.length ? item.children.flatMap(choiceLeaves) : [item];
}
export function choiceItems(items: ChoiceItem[]): ChoiceItem[] {
  return items.flatMap((item) => [item, ...choiceItems(item.children ?? [])]);
}
export function choiceRows(
  items: ChoiceItem[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parent?: string,
  section?: string,
): ChoiceRow[] {
  return items.flatMap((item) => {
    const heading = item.section ?? section;
    return [
      {
        item,
        depth,
        ...(parent === undefined ? {} : { parent }),
        ...(heading === undefined ? {} : { section: heading }),
      },
      ...(item.children?.length && expanded.has(item.name)
        ? choiceRows(item.children, expanded, depth + 1, item.name, heading)
        : []),
    ];
  });
}
