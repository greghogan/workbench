import { diffLines } from "diff";
import { InvalidInput } from "../../core/runtime/input-errors.js";

export interface FileLine {
  number: number;
  start: number;
  text: string;
}
export interface FileSection {
  same: boolean;
  before: FileLine[];
  after: FileLine[];
}
export const fileContextLines = 3;
export const filePreviewByteLimit = 64 * 1024;
const expansionLines = 20;
export const fileDisplayLineLimit = 10000;

/** jsdiff owns matching; this model only numbers literal lines and chooses visible context. */
export function compareFileLines(before: string, after: string) {
  const sections: FileSection[] = [];
  let oldOffset = 0,
    newOffset = 0,
    oldLine = 1,
    newLine = 1;
  const changes = diffLines(before, after, { maxEditLength: 4000 });
  for (const part of changes ?? [
    { removed: true, value: before },
    { added: true, value: after },
  ]) {
    const same = !part.added && !part.removed;
    let section = sections.at(-1);
    if (section?.same !== same || same) {
      section = { same, before: [], after: [] };
      sections.push(section);
    }
    for (const text of part.value.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (!part.added) {
        section.before.push({ number: oldLine++, start: oldOffset, text });
        oldOffset += text.length;
      }
      if (!part.removed) {
        section.after.push({ number: newLine++, start: newOffset, text });
        newOffset += text.length;
      }
    }
  }
  return { sections, detailed: changes !== undefined, lines: Math.max(oldLine, newLine) - 1 };
}

/** Common sections expand independently from either edge; URLs retain those choices. */
export function fileContext(value?: string) {
  const expanded = new Map<number, [number, number]>();
  if (value && value !== "all") {
    if (value.length > 4096) throw new InvalidInput("File context selection is too large");
    for (const field of value.split(",")) {
      if (!/^\d{1,6}:\d{1,6}:\d{1,6}$/.test(field)) throw new InvalidInput("Invalid file context selection");
      const [index = 0, top = 0, bottom = 0] = field.split(":").map(Number);
      if (expanded.has(index)) throw new InvalidInput("Repeated file context selection");
      expanded.set(index, [top, bottom]);
    }
  }
  return {
    visible(index: number, length: number, first: boolean, last: boolean) {
      if (value === "all") return { top: length, bottom: 0 };
      const [extraTop, extraBottom] = expanded.get(index) ?? [0, 0];
      const top = Math.min(length, (first ? 0 : fileContextLines) + extraTop);
      return { top, bottom: Math.min(length - top, (last ? 0 : fileContextLines) + extraBottom) };
    },
    expand(index: number, edge: "top" | "bottom") {
      const next = new Map(expanded);
      const counts = [...(next.get(index) ?? [0, 0])] as [number, number];
      const side = edge === "top" ? 0 : 1;
      counts[side] = Math.min(fileDisplayLineLimit, counts[side] + expansionLines);
      next.set(index, counts);
      return [...next]
        .sort(([a], [b]) => a - b)
        .map(([id, [a, b]]) => `${String(id)}:${String(a)}:${String(b)}`)
        .join(",");
    },
  };
}
