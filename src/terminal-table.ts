/** Plain text tables remain readable in terminals and redirected output. */
export function terminalTable(header: string[], rows: string[][]): string {
  const clean = (value: string) => value.replace(/\p{Cc}/gu, " ");
  const values = [header, ...rows].map((row) => row.map(clean));
  const widths = header.map((_, column) => Math.max(...values.map((row) => row[column]?.length ?? 0)));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  return [
    border,
    ...values.flatMap((row, index) => [
      `| ${header.map((_, column) => (row[column] ?? "").padEnd(widths[column] ?? 0)).join(" | ")} |`,
      ...(index === 0 ? [border] : []),
    ]),
    border,
  ].join("\n");
}
