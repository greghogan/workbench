import { plainOutput } from "./presentation.js";
import { stripVTControlCharacters } from "node:util";

/** Plain text tables remain readable in terminals and redirected output. */
export function terminalTable(
  header: string[],
  rows: string[][],
  options: {
    quantities?: number[];
    separators?: { after: number; from?: number }[];
    maxWidths?: Record<number, number>;
  } = {},
): string {
  const clean = (value: string) => stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");
  const values = [header, ...rows].map((row) => row.map(clean));
  if (plainOutput()) {
    const labels = values[0] ?? [];
    if (!rows.length) return `${labels.join("; ")}\nNo entries.`;
    return values
      .slice(1)
      .map((row) => labels.map((label, column) => `${label}: ${row[column] ?? ""}`).join("\n"))
      .join("\n\n");
  }
  for (const column of options.quantities ?? []) {
    const quantities = values.slice(1).map((row) => /^(\d+(?:\.\d+)?) ([A-Za-z]+)$/.exec(row[column] ?? ""));
    const unitWidth = Math.max(1, ...quantities.map((match) => match?.[2]?.length ?? 0));
    const numberWidth = Math.max(
      (header[column]?.length ?? 0) - unitWidth - 1,
      ...quantities.map((match) => match?.[1]?.length ?? 0),
    );
    for (const [index, match] of quantities.entries()) {
      const row = values[index + 1];
      if (row && match) row[column] = `${(match[1] ?? "").padStart(numberWidth)} ${(match[2] ?? "").padEnd(unitWidth)}`;
    }
  }
  const widths = header.map((_, column) => {
    const natural = Math.max(...values.map((row) => row[column]?.length ?? 0));
    return Math.max(values[0]?.[column]?.length ?? 0, Math.min(options.maxWidths?.[column] ?? Infinity, natural));
  });
  const rule = (from = 0) =>
    `${widths.map((width, column) => `${column < from ? "|" : "+"}${(column < from ? " " : "-").repeat(width + 2)}`).join("")}+`;
  const border = rule();
  const render = (row: string[]) => {
    const cells = header.map((_, column) => {
      const value = row[column] ?? "";
      const width = Math.max(1, widths[column] ?? 0);
      return Array.from({ length: Math.max(1, Math.ceil(value.length / width)) }, (_, index) =>
        value.slice(index * width, (index + 1) * width),
      );
    });
    return Array.from(
      { length: Math.max(...cells.map((cell) => cell.length)) },
      (_, line) => `| ${cells.map((cell, column) => (cell[line] ?? "").padEnd(widths[column] ?? 0)).join(" | ")} |`,
    ).join("\n");
  };
  const separators = new Map<number, number[]>();
  for (const { after, from = 0 } of options.separators ?? []) {
    const rules = separators.get(after) ?? [];
    rules.push(from);
    separators.set(after, rules);
  }
  const lines = [border, render(values[0] ?? []), border];
  for (const [index, row] of values.slice(1).entries()) {
    lines.push(render(row));
    if (index < rows.length - 1) for (const from of separators.get(index) ?? []) lines.push(rule(from));
  }
  if (rows.length) lines.push(border);
  return lines.join("\n");
}
