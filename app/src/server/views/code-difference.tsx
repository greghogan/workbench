import type { ComponentChildren, JSX } from "preact";
import { codeTokens, codeRange } from "./code-highlighting.js";
import { diffIcon } from "./diff-icons.js";
import { compareFileLines, fileContext, fileDisplayLineLimit, type FileLine } from "../review/file-comparison.js";

export interface FileDifferenceOptions {
  context?: string;
  location?: (context: string) => string;
}

/** Literal source comparisons share numbered rows, context controls, and whole-file syntax tokens. */
export function codeDifference(
  before: string | undefined,
  after: string | undefined,
  split: boolean,
  path = "",
  options: FileDifferenceOptions = {},
): JSX.Element {
  const exceedsLines = (text: string) => {
    let offset = 0;
    for (let count = 0; count <= fileDisplayLineLimit; count++) {
      const next = text.indexOf("\n", offset);
      if (next < 0) return count + (offset < text.length ? 1 : 0) > fileDisplayLineLimit;
      if (count === fileDisplayLineLimit) return true;
      offset = next + 1;
    }
    return false;
  };
  if (exceedsLines(before ?? "") || exceedsLines(after ?? ""))
    return <p class="notice">This file has too many lines for an interactive diff. Download the file to inspect it.</p>;
  const comparison = compareFileLines(before ?? "", after ?? ""),
    context = fileContext(options.context);
  const old = codeTokens(before ?? "", path),
    current = codeTokens(after ?? "", path);
  const content = (line: FileLine | undefined, side: "before" | "after") => {
    if (!line) return null;
    const terminated = line.text.endsWith("\n");
    return (
      <>
        <code data-source-line="" data-newline={terminated ? "1" : "0"}>
          {codeRange(
            side === "before" ? old : current,
            line.start,
            line.text.length - (line.text.endsWith("\r\n") ? 2 : terminated ? 1 : 0),
          )}
        </code>
        {!terminated && <span class="diff-no-newline">No newline at end of file</span>}
      </>
    );
  };
  const number = (line: FileLine | undefined) => <td class="diff-number">{line?.number}</td>;
  const row = (a: FileLine | undefined, b: FileLine | undefined, same: boolean): ComponentChildren => {
    if (split)
      return (
        <tr class={same ? "diff-context" : "diff-change"}>
          {number(a)}
          <td class={a && !same ? "diff-code diff-removed" : "diff-code"} data-side="before">
            {content(a, "before")}
          </td>
          {number(b)}
          <td class={b && !same ? "diff-code diff-added" : "diff-code"} data-side="after">
            {content(b, "after")}
          </td>
        </tr>
      );
    return (
      <tr class={same ? "diff-context" : b ? "diff-added" : "diff-removed"}>
        {number(a)}
        {number(b)}
        <td class="diff-sign">
          <span aria-hidden="true">{same ? " " : b ? "+" : "−"}</span>
        </td>
        <td class="diff-code" data-side={same ? "both" : b ? "after" : "before"}>
          {content(b ?? a, b ? "after" : "before")}
        </td>
      </tr>
    );
  };
  return (
    <>
      {!comparison.detailed && (
        <p class="notice">
          Detailed matching is unavailable; all previous lines and current lines are shown separately.
        </p>
      )}
      {before === after && <p class="muted">File contents unchanged.</p>}
      {options.location && options.context !== "all" && comparison.sections.some((section) => section.same) && (
        <div class="diff-tools">
          <a data-file-diff-link="" href={options.location("all")}>
            Expand all lines
          </a>
        </div>
      )}
      {/* Keyboard users need a tab stop to scroll long source lines. */}
      {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex */}
      <section class="file-diff-scroll" tabIndex={0} aria-label={path ? `File diff: ${path}` : "File diff"}>
        <table class={"file-diff" + (split ? " file-diff-split" : "")}>
          <caption class="sr-only">
            {split ? "Side-by-side file changes" : "Unified file changes"}
            {path ? `: ${path}` : ""}
          </caption>
          <thead class="sr-only">
            <tr>
              {split ? (
                <>
                  <th scope="col">Previous line</th>
                  <th scope="col">Previous source</th>
                  <th scope="col">Current line</th>
                  <th scope="col">Current source</th>
                </>
              ) : (
                <>
                  <th scope="col">Previous line</th>
                  <th scope="col">Current line</th>
                  <th scope="col">Change</th>
                  <th scope="col">Source</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {comparison.sections.map((section, index) => {
              if (!section.same) {
                if (!split)
                  return (
                    <>
                      {section.before.map((line) => row(line, undefined, false))}
                      {section.after.map((line) => row(undefined, line, false))}
                    </>
                  );
                return Array.from({ length: Math.max(section.before.length, section.after.length) }, (_, i) =>
                  row(section.before[i], section.after[i], false),
                );
              }
              const { top, bottom } = context.visible(
                  index,
                  section.before.length,
                  index === 0,
                  index === comparison.sections.length - 1,
                ),
                hidden = section.before.length - top - bottom;
              return (
                <>
                  {section.before.slice(0, top).map((line, i) => row(line, section.after[i], true))}
                  {hidden > 0 && (
                    <tr class="diff-gap">
                      <td colSpan={split ? 1 : 2} class="diff-expand-cell">
                        {options.location && (
                          <span class="diff-gap-actions">
                            {index !== comparison.sections.length - 1 && (
                              <a
                                data-file-diff-link=""
                                class="diff-expand"
                                aria-label="Show more lines above"
                                href={options.location(context.expand(index, "bottom"))}
                              >
                                {diffIcon("up")}
                              </a>
                            )}
                            {index !== 0 && (
                              <a
                                data-file-diff-link=""
                                class="diff-expand"
                                aria-label="Show more lines below"
                                href={options.location(context.expand(index, "top"))}
                              >
                                {diffIcon("down")}
                              </a>
                            )}
                          </span>
                        )}
                      </td>
                      <td colSpan={split ? 3 : 2} class="diff-gap-description">
                        {String(hidden)} unchanged {hidden === 1 ? "line" : "lines"}
                      </td>
                    </tr>
                  )}
                  {section.before
                    .slice(section.before.length - bottom)
                    .map((line, i) => row(line, section.after[section.after.length - bottom + i], true))}
                </>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
