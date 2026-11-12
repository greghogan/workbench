import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { choiceItems, choiceLeaves, choiceRows, initialChoice, updateChoice, type ChoiceItem } from "./choice-tree.js";
import type { TerminalInput, TerminalOutput } from "./terminal-choice.js";

const text = (value: string): string =>
  stripVTControlCharacters(value).replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : " "));

/** Complete, stable numbered choices retain the same selection rules without raw-mode navigation. */
export async function choosePlainItems(
  title: string,
  items: ChoiceItem[],
  enabled: string[],
  input: TerminalInput,
  output: TerminalOutput,
  confirmation?: (selected: string[]) => string,
): Promise<string[] | undefined> {
  const flowing = input.readableFlowing;
  const raw = input.isRaw;
  if (raw) input.setRawMode(false);
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  const answers = lines[Symbol.asyncIterator]();
  let failure: Error | undefined;
  const cancel = () => {
    lines.close();
  };
  const fail = (error: Error) => {
    failure = error;
    cancel();
  };
  const terminate = () => {
    fail(new Error("selection interrupted"));
  };
  const closed = () => {
    fail(new Error("Selector output closed"));
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", terminate);
  output.once("error", fail);
  output.once("close", closed);
  const write = (value: string) => {
    output.write(`${text(value)}\n`);
  };
  const answer = async (): Promise<string | undefined> => {
    const next = await answers.next();
    if (failure) throw failure;
    return next.done ? undefined : next.value.trim();
  };
  let state = initialChoice(items, enabled);
  const expanded = new Set(choiceItems(items).map((item) => item.name));
  const rows = choiceRows(items, expanded);
  const paths = new Map<string, string[]>();
  for (const { item, parent } of rows)
    paths.set(item.name, [...(parent ? (paths.get(parent) ?? []) : []), item.label ?? item.name]);
  try {
    for (;;) {
      write(title);
      write("Enter a number or comma-separated numbers to toggle; all or none; Enter to continue; cancel to cancel.");
      for (const [index, { item, section }] of rows.entries()) {
        const candidates = choiceLeaves(item).filter((leaf) => !leaf.disabled?.(state.selected));
        const chosen = candidates.filter((leaf) => state.selected.has(leaf.name));
        const disabled = !candidates.length || (item.disabled?.(state.selected) ?? false);
        const status = disabled
          ? "disabled"
          : chosen.length === candidates.length
            ? "selected"
            : chosen.length
              ? "partly selected"
              : "not selected";
        const reason = typeof item.reason === "function" ? item.reason(state.selected) : item.reason;
        write(
          `${String(index + 1)}. ${section ? `${section}: ` : ""}${paths.get(item.name)?.join(" / ") ?? item.name}: ${status}${reason ? ` (${reason})` : ""}`,
        );
      }
      write("Selection:");
      const value = await answer();
      if (value === undefined || /^(cancel|q)$/i.test(value)) return undefined;
      if (value === "" || value.toLowerCase() === "done") {
        state = updateChoice({ ...state, index: 0 }, "save", items, confirmation !== undefined);
        if (state.phase === "finished") return state.result;
        write(confirmation?.([...state.selected].sort()) ?? title);
        write("Type yes to delete; any other answer cancels.");
        return updateChoice(state, (await answer())?.toLowerCase() === "yes" ? "confirm" : "cancel", items, true)
          .result;
      }
      if (/^(all|none)$/i.test(value))
        state = updateChoice({ ...state, index: value.toLowerCase() === "all" ? 0 : 1 }, "toggle", items, false);
      else {
        const numbers = /^\d+(?:\s*,\s*\d+)*$/.test(value) ? value.split(",").map(Number) : [];
        if (!numbers.length || numbers.some((number) => number < 1 || number > rows.length)) {
          write("Invalid selection. Use the listed numbers, all, none, Enter, or cancel.");
          continue;
        }
        for (const number of new Set(numbers))
          state = updateChoice({ ...state, expanded, index: number + 1 }, "toggle", items, false);
      }
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", terminate);
    output.removeListener("error", fail);
    output.removeListener("close", closed);
    lines.close();
    if (raw) input.setRawMode(raw);
    if (flowing) input.resume();
    else input.pause();
  }
}
