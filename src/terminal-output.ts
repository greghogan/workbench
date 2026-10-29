import { stripVTControlCharacters } from "node:util";

/** Preserve line structure while removing terminal controls from untrusted output. */
export const safeOutput = (text: string): string =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
