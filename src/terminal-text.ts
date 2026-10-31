import { safeOutput } from "./terminal-output.js";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const oneLine = (text: string) => safeOutput(text).replaceAll("\n", " ").replaceAll("\t", " ");
export const terminalColumns = (text: string): number => stringWidth(oneLine(text));

/** A table cannot fit a complete grapheme into fewer cells than that grapheme occupies. */
export function minimumTerminalWidth(text: string): number {
  let width = 1;
  for (const { segment } of graphemes.segment(oneLine(text))) width = Math.max(width, stringWidth(segment));
  return width;
}

export function wrapTerminalText(text: string, width: number): string[] {
  const value = oneLine(text);
  const original = [...graphemes.segment(value)].map(({ segment }) => segment);
  let offset = 0;
  // wrap-ansi normalizes Unicode. Use its line boundaries while retaining exact path/identifier spelling.
  return wrapAnsi(value, Math.max(1, width), { hard: true, wordWrap: false, trim: false })
    .split("\n")
    .map((line) => {
      const count = [...graphemes.segment(line)].length;
      const result = original.slice(offset, offset + count).join("");
      offset += count;
      return result;
    });
}

/** Bound display cells without splitting a combining sequence or emoji grapheme. */
export function fitTerminalText(text: string, width: number): string {
  let result = "",
    used = 0;
  for (const { segment } of graphemes.segment(oneLine(text))) {
    used += stringWidth(segment);
    if (used > width) break;
    result += segment;
  }
  return result;
}
