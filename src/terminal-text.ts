import { stripVTControlCharacters } from "node:util";

/** Preserve line structure while removing terminal controls from untrusted output. */
export const safeOutput = (text: string): string =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A conservative byte budget also bounds terminal columns without splitting graphemes. */
export function fitTerminalText(text: string, width: number): string {
  let result = "",
    used = 0;
  for (const { segment } of graphemes.segment(safeOutput(text).replaceAll("\n", " ").replaceAll("\t", " "))) {
    used += Buffer.byteLength(segment);
    if (used > width) break;
    result += segment;
  }
  return result;
}
