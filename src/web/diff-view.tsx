import type { ComponentChildren, JSX } from "preact";
import { parsePatch } from "diff";
import type { SourceDifference } from "./diff.js";
import type { DiffPart } from "./paragraph-diff.js";
import type { ComparisonResult } from "./comparison-result.js";
/** jsdiff parses Git patches; this renderer only lays out the library's hunk rows. */
export function diffView(diff: string, split = false): JSX.Element {
  const rows: JSX.Element[] = [];
  const cell = (line: number | undefined, text: string, tone = "") => (
    <>
      <span class="number">{line === undefined ? "" : String(line)}</span>
      <span class={tone}>{text}</span>
    </>
  );
  for (const patch of parsePatch(diff)) {
    if (patch.oldMode && patch.newMode && patch.oldMode !== patch.newMode)
      rows.push(
        <p class="diff-header">
          File mode: {patch.oldMode} → {patch.newMode}
        </p>,
      );
    for (const hunk of patch.hunks) {
      let before = hunk.oldStart,
        after = hunk.newStart;
      rows.push(
        <div class="diff-row hunk">
          {"@@ -" +
            String(before) +
            "," +
            String(hunk.oldLines) +
            " +" +
            String(after) +
            "," +
            String(hunk.newLines) +
            " @@"}
        </div>,
      );
      const lines = hunk.lines;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (split && (line.startsWith("-") || line.startsWith("+"))) {
          const removed: string[] = [],
            added: string[] = [];
          while (lines[index]?.startsWith("-")) {
            removed.push(lines[index]?.slice(1) ?? "");
            index++;
          }
          while (lines[index]?.startsWith("+")) {
            added.push(lines[index]?.slice(1) ?? "");
            index++;
          }
          index--;
          for (let row = 0; row < Math.max(removed.length, added.length); row++) {
            const old = removed[row],
              next = added[row];
            rows.push(
              <div class="diff-row">
                {cell(old === undefined ? undefined : before++, old === undefined ? "" : "− " + old, "old")}
                {cell(next === undefined ? undefined : after++, next === undefined ? "" : "+ " + next, "new")}
              </div>,
            );
          }
        } else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
          const addition = line.startsWith("+"),
            removal = line.startsWith("-"),
            a = addition ? undefined : before++,
            b = removal ? undefined : after++;
          rows.push(
            split ? (
              <div class="diff-row">
                {cell(a, line.slice(1))}
                {cell(b, line.slice(1))}
              </div>
            ) : (
              <div class={"diff-row " + (addition ? "add" : removal ? "remove" : "")}>
                <span class="number">{a === undefined ? "" : String(a)}</span>
                <span class="number">{b === undefined ? "" : String(b)}</span>
                <span>{line}</span>
              </div>
            ),
          );
        } else if (line) rows.push(<div class="diff-header">{line}</div>);
      }
    }
  }
  return (
    // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- This named scroll region needs keyboard focus for horizontal scrolling.
    <section class={"diff" + (split ? " split" : "")} aria-label="Source differences" tabIndex={0}>
      {rows.length ? rows : <p class="empty">No source differences.</p>}
    </section>
  );
}
function highlightedPart(part: DiffPart): ComponentChildren {
  if (part.change === "same") return part.text;
  const Tag = part.change === "added" ? "ins" : "del";
  const whitespace = part.text.length > 0 && !part.text.trim();
  return (
    <Tag class={whitespace ? "diff-whitespace" : undefined} title={whitespace ? "Whitespace change" : undefined}>
      {part.text}
    </Tag>
  );
}
/** Inline review follows logical paragraphs; the source layout retains exact line changes. */
export function sourceDiffView(difference: SourceDifference | null | undefined, split = false): JSX.Element {
  if (split) return diffView(difference?.patch ?? "", true);
  const modes = (difference ? parsePatch(difference.patch) : []).flatMap((patch) =>
    patch.oldMode && patch.newMode && patch.oldMode !== patch.newMode
      ? [
          <p class="diff-header">
            File mode: {patch.oldMode} → {patch.newMode}
          </p>,
        ]
      : [],
  );
  const paragraphs = difference?.paragraphs;
  if (!paragraphs?.changes.length)
    return (
      <section class="paragraph-diff" aria-label="Paragraph differences">
        {modes}
        <p class="empty">
          {paragraphs?.formattingOnly
            ? "Only paragraph wrapping or formatting changed. Use Side-by-side or Raw to inspect the exact formatting."
            : modes.length
              ? "File contents unchanged."
              : "No source differences."}
        </p>
      </section>
    );
  let section = "";
  const changes = paragraphs.changes.map((change) => {
    const heading =
      change.section && change.section !== section ? <h3 class="diff-section">{change.section}</h3> : null;
    section = change.section;
    const label = change.before === null ? "Added" : change.after === null ? "Removed" : "Changed";
    return (
      <>
        {heading}
        <section
          class={"diff-paragraph" + (change.kind === "literal" ? " literal" : "")}
          aria-label={label + " " + (change.kind === "literal" ? "source block" : "paragraph")}
        >
          <div class="diff-content">
            {change.parts.map((part, index) => (
              <>
                {part.change === "added" && change.parts[index - 1]?.change === "removed" && (
                  <span class="diff-separator" aria-hidden="true">
                    {" "}
                  </span>
                )}
                {highlightedPart(part)}
              </>
            ))}
          </div>
        </section>
      </>
    );
  });
  return (
    <section class="paragraph-diff" aria-label="Paragraph differences">
      {modes}
      {paragraphs.coarse && <p class="notice">Some changes are shown as complete paragraph additions and removals.</p>}
      {changes}
    </section>
  );
}
export function comparisonView(result: ComparisonResult, split = false): JSX.Element {
  return result.state === "unavailable" ? (
    <p class="notice">Source differences unavailable: {result.problem}</p>
  ) : (
    sourceDiffView(result.difference, split)
  );
}
