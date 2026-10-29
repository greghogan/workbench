import { safeOutput } from "./terminal-output.js";
import stringWidth from "string-width";

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
  const lines: string[] = [];
  const limit = Math.max(1, width);
  let line = "",
    used = 0;
  for (const { segment } of graphemes.segment(oneLine(text))) {
    const cells = stringWidth(segment);
    if (line && used + cells > limit) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += segment;
    used += cells;
  }
  lines.push(line);
  return lines;
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
