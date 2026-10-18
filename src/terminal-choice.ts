import { emitKeypressEvents, type Key } from "node:readline";
import { plainOutput } from "./presentation.js";
import { choosePlainItems } from "./plain-choice.js";
import type { Readable, Writable } from "node:stream";
import {
  choiceLeaves,
  choiceRows,
  initialChoice,
  updateChoice,
  type ChoiceItem,
  type ChoiceAction,
} from "./choice-tree.js";

const bindings = {
  up: { action: "previous", label: "Up" },
  down: { action: "next", label: "Down" },
  space: { action: "toggle", label: "Space" },
  return: { action: "save", label: "Enter" },
  escape: { action: "cancel", label: "Esc" },
} as const;
const help = `${bindings.up.label}/${bindings.down.label} move; ${bindings.space.label} toggles; ${bindings.return.label} continues; ${bindings.escape.label} cancels.`;
const confirmBinding = { name: "y", label: "Y" };

export interface TerminalInput extends Readable {
  isTTY?: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): unknown;
}

export interface TerminalOutput extends Writable {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
}

/** Redirected Node streams can omit isTTY, despite the narrower ReadStream/WriteStream declarations. */
export function terminalAvailable(
  input: { isTTY?: boolean } = process.stdin,
  output: { isTTY?: boolean } = process.stdout,
): boolean {
  return (input.isTTY ?? false) && (output.isTTY ?? false);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function fitLine(line: string, width: number): string {
  let result = "",
    used = 0;
  // A UTF-8 byte budget conservatively bounds columns without splitting Unicode graphemes.
  for (const { segment } of segmenter.segment(line.replace(/\p{Cc}/gu, " "))) {
    const size = Buffer.byteLength(segment);
    if (used + size > width) break;
    result += segment;
    used += size;
  }
  return result;
}

/** Terminal interaction stays separate from filesystem changes, so cancellation has no effects. */
export function chooseItems(
  title: string,
  items: ChoiceItem[],
  enabled: string[],
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
  confirmation?: (selected: string[]) => string,
): Promise<string[] | undefined> {
  if (!terminalAvailable(input, output))
    throw new Error("selection needs a terminal; use explicit command options or --json");
  if (plainOutput() || process.env.TERM === "dumb")
    return choosePlainItems(title, items, enabled, input, output, confirmation);
  return new Promise((resolve, reject) => {
    const leaves = items.flatMap(choiceLeaves);
    const raw = input.isRaw,
      flowing = input.readableFlowing;
    let state = initialChoice(items, enabled);
    const rows = () => choiceRows(items, state.expanded);
    let lines = 0,
      finished = false,
      outputFailed = false,
      cursorHidden = false;
    function render(): void {
      const { index, selected } = state;
      const confirming = state.phase === "confirming";
      const prompt = confirming ? (confirmation?.([...selected].sort()) ?? title).split("\n") : [];
      const terminalRows = output.rows ?? 0;
      const terminalColumns = output.columns ?? 0;
      const height = Math.max(5, (terminalRows === 0 ? 24 : terminalRows) - 2);
      const width = Math.max(1, (terminalColumns === 0 ? 80 : terminalColumns) - 1);
      const flat = rows();
      const showSections = height >= 6;
      const sectionCount = showSections ? new Set(flat.flatMap((row) => (row.section ? [row.section] : []))).size : 0;
      const count = Math.max(1, height - (confirming ? 4 + prompt.length : 4) - sectionCount);
      const first = index < 2 ? 0 : Math.max(0, Math.min(index - 2, flat.length - count));
      const visible = [
        ...(confirming ? [] : [0, 1]),
        ...flat.slice(first, first + count).map((_row, offset) => first + offset + 2),
      ];
      const text = [
        title,
        ...(confirming
          ? []
          : [
              items.some((item) => item.children?.length)
                ? "Up/Down move; Space toggles; Tab opens; Enter parent/continue; Esc cancels."
                : help,
            ]),
        ...visible.flatMap((row, offset) => {
          const context = row < 2 ? undefined : flat[row - 2],
            item = context?.item;
          const candidates = item
            ? choiceLeaves(item).filter((leaf) => !leaf.disabled?.(selected))
            : leaves.filter((leaf) => !leaf.disabled?.(selected));
          const chosen = candidates.filter((leaf) => selected.has(leaf.name));
          const disabled = item ? !candidates.length || (item.disabled?.(selected) ?? false) : false;
          const checked =
            item || row === 0 ? candidates.length > 0 && chosen.length === candidates.length : selected.size === 0;
          const partial = !!item && chosen.length > 0 && chosen.length < candidates.length;
          const checkbox = disabled ? "[-]" : partial ? "[~]" : `[${checked ? "x" : " "}]`;
          const reason = typeof item?.reason === "function" ? item.reason(selected) : item?.reason;
          const previous = flat[(visible[offset - 1] ?? 0) - 2];
          const heading =
            showSections && context?.section && context.section !== previous?.section ? [context.section + ":"] : [];
          const label = item ? (item.label ?? item.name) : row === 0 ? "Select all" : "Select none";
          const branch = item?.children?.length ? (state.expanded.has(item.name) ? " ▾" : " ▸") : "";
          return [
            ...heading,
            `${row === index && !confirming ? ">" : " "} ${"  ".repeat(context?.depth ?? 0)}${checkbox} ${label}${branch}${reason ? ` (${reason})` : ""}${disabled ? " [disabled]" : ""}`,
          ];
        }),
        ...(confirming ? [...prompt, `${confirmBinding.label} deletes; any other key cancels.`] : []),
      ].map((line) => fitLine(line, width));
      lines = Math.min(lines, height);
      if (lines) output.write(`\u001b[${String(lines)}A`);
      for (let row = 0; row < Math.max(lines, text.length); row++) output.write(`\r\u001b[2K${text[row] ?? ""}\n`);
      lines = Math.max(lines, text.length);
    }
    function finish(value?: string[], failure?: unknown): void {
      if (finished) return;
      finished = true;
      const failures: unknown[] = failure === undefined ? [] : [failure];
      const attempt = (action: () => void) => {
        try {
          action();
        } catch (error) {
          failures.push(error);
        }
      };
      input.removeListener("keypress", keypress);
      input.removeListener("end", end);
      input.removeListener("error", fail);
      output.removeListener("resize", resize);
      output.removeListener("error", failOutput);
      output.removeListener("close", closeOutput);
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
      attempt(() => {
        input.setRawMode(raw);
      });
      attempt(() => {
        if (flowing) input.resume();
        else input.pause();
      });
      if (cursorHidden && !outputFailed && !output.destroyed)
        attempt(() => {
          output.write("\u001b[?25h");
        });
      const [primary, ...cleanup] = failures.map((error) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      if (primary)
        reject(
          cleanup.length
            ? new AggregateError(
                [primary, ...cleanup],
                `Selector and terminal restoration failed: ${[primary, ...cleanup].map(String).join("; ")}`,
              )
            : primary,
        );
      else resolve(value);
    }
    const end = () => {
      finish();
    };
    const fail = (error: Error) => {
      finish(undefined, error);
    };
    const failOutput = (error: Error) => {
      outputFailed = true;
      finish(undefined, error);
    };
    const closeOutput = () => {
      failOutput(new Error("Selector output closed"));
    };
    const terminate = () => {
      finish(undefined, new Error("selection interrupted"));
    };
    const interrupt = () => {
      finish();
    };
    const resize = () => {
      try {
        render();
      } catch (error) {
        finish(undefined, error);
      }
    };
    function keypress(_text: string, key: Key): void {
      try {
        const action: ChoiceAction | undefined =
          key.ctrl && key.name === "c"
            ? "cancel"
            : key.name === "tab"
              ? key.shift
                ? "parent"
                : "open"
              : key.name === confirmBinding.name && !key.ctrl && !key.meta
                ? "confirm"
                : Object.entries(bindings).find(([name]) => name === key.name)?.[1].action;
        state = updateChoice(state, action, items, confirmation !== undefined);
        if (state.phase === "finished") finish(state.result);
        else render();
      } catch (error) {
        finish(undefined, error);
      }
    }
    try {
      emitKeypressEvents(input);
      input.on("keypress", keypress);
      input.once("end", end);
      input.once("error", fail);
      output.on("resize", resize);
      output.once("error", failOutput);
      output.once("close", closeOutput);
      process.once("SIGTERM", terminate);
      process.once("SIGINT", interrupt);
      input.setRawMode(true);
      input.resume();
      cursorHidden = true;
      output.write("\u001b[?25l");
      render();
    } catch (error) {
      finish(undefined, error);
    }
  });
}
