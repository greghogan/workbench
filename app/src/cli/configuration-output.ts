import { inspectConfiguration, type ConfigScope } from "../core/configuration/config-command.js";
import { plainOutput } from "../core/diagnostics/presentation.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
const formatValue = (value: unknown): string =>
  value === undefined ? "<unset>" : typeof value === "string" ? value : JSON.stringify(value);

/** Wrap complete values only to fit the remaining table column. */
function overviewValue(value: unknown, width: number): string[] {
  const text = formatValue(value).replace(/\p{Cc}/gu, " ");
  if (plainOutput()) return [text];
  const characters = Array.from(text);
  const lines: string[] = [];
  for (let start = 0; start < characters.length; start += width)
    lines.push(characters.slice(start, start + width).join(""));
  return lines.length ? lines : [""];
}

export function showConfiguration(root: string, scope?: ConfigScope, key?: string): void {
  const inspection = inspectConfiguration(root, scope, key);
  if (inspection.kind === "value") {
    console.log(formatValue(inspection.value));
    return;
  }
  const { values, sources } = inspection;
  const nameWidth = Math.max("OPTION".length, ...[...values.keys()].map((name) => name.length));
  const scopeWidth = Math.max("SCOPE".length, ...[...values.values()].map((entry) => entry.scope.length));
  const columns = process.stdout.columns || 80;
  const valueWidth = Math.max("VALUE".length, columns - nameWidth - scopeWidth - 10);
  const rows = [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, entry]) =>
      overviewValue(entry.value, valueWidth).map((line, index) => [index ? "" : name, line, index ? "" : entry.scope]),
    );
  console.log(terminalTable(["OPTION", "VALUE", "SCOPE"], rows));
  console.log("\n" + sources.join("\n"));
  console.log("\nRaw value: workbench config get <option> [--scope global|project|local]");
}
