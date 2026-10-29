import { prepareDocumentComparison } from "./document-comparison-model.js";
import type { ComponentChildren, JSX } from "preact";
import { parsePatch } from "diff";
import type { SourceDifference } from "./diff.js";
import { isDeepStrictEqual } from "node:util";
import { metadataLabel } from "../record-metadata.js";
import type { RecordLookup } from "../record-lookup.js";
import { metadataSection, metadataValue } from "./record-content.js";
import { markdownParser, markdownTokens, type MarkdownRecord } from "./markdown-view.js";
import { reviewAnnotations, type TextPart } from "./document-comparison.js";
import type { ComparisonResult } from "./comparison-result.js";
export interface DifferenceContext {
  record?: MarkdownRecord | undefined;
  records: RecordLookup;
  pageTitle?: string;
}
function highlightedPart(part: TextPart): ComponentChildren {
  if (part.change === "same") return part.text;
  const Tag = part.change === "added" ? "ins" : "del";
  const whitespace = part.text.length > 0 && !part.text.trim();
  return (
    <Tag class={whitespace ? "diff-whitespace" : undefined} title={whitespace ? "Whitespace change" : undefined}>
      {part.text}
    </Tag>
  );
}
function separated(parts: TextPart[]): ComponentChildren {
  return parts.map((part, index) => (
    <>
      {part.change === "added" && parts[index - 1]?.change === "removed" && (
        <span class="diff-separator" aria-hidden="true">
          {" "}
        </span>
      )}
      {highlightedPart(part)}
    </>
  ));
}
/** Complete formatted documents share the normal renderer's escaping, links, headings, and metadata presentation. */
export function sourceDiffView(
  difference: SourceDifference | null | undefined,
  context: DifferenceContext,
  split = false,
): JSX.Element {
  if (!difference) return <p class="empty">No source differences.</p>;
  const {
    old,
    next,
    compared,
    rows: metadataRows,
    sameMetadata,
  } = prepareDocumentComparison(difference, context.pageTitle);
  const parser = markdownParser(context.record, context.records),
    previous = markdownParser(context.record, context.records, "previous-"),
    current = markdownParser(context.record, context.records, "current-");
  for (const renderer of [parser, previous, current]) reviewAnnotations(renderer);
  const rows = metadataRows.map(({ key, before, after, same, parts }) => {
    const value = (side: "unified" | "previous" | "current") => {
      const present =
        side === "previous"
          ? Object.hasOwn(old.values, key)
          : side === "current"
            ? Object.hasOwn(next.values, key)
            : true;
      if (!present) return null;
      let content: ComponentChildren;
      if (same) content = metadataValue(after, context.records);
      else if (parts)
        content = (
          <span class="metadata-text">
            {separated(
              parts.filter((part) => side === "unified" || part.change !== (side === "previous" ? "added" : "removed")),
            )}
          </span>
        );
      else
        content = (
          <>
            {side !== "current" && Object.hasOwn(old.values, key) && (
              <del>{metadataValue(before, context.records)}</del>
            )}
            {side === "unified" && Object.hasOwn(old.values, key) && Object.hasOwn(next.values, key) && (
              <span class="diff-separator" aria-hidden="true">
                {" "}
              </span>
            )}
            {side !== "previous" && Object.hasOwn(next.values, key) && (
              <ins>{metadataValue(after, context.records)}</ins>
            )}
          </>
        );
      return (
        <section class="record-metadata">
          {metadataSection(
            side === "unified" && !Object.hasOwn(next.values, key) ? (
              <del>{metadataLabel(key)}</del>
            ) : side === "unified" && !Object.hasOwn(old.values, key) ? (
              <ins>{metadataLabel(key)}</ins>
            ) : (
              metadataLabel(key)
            ),
            content,
          )}
        </section>
      );
    };
    return { unified: value("unified"), previous: value("previous"), current: value("current") };
  });
  const modeChanges = parsePatch(difference.patch).flatMap((patch) =>
    patch.oldMode && patch.newMode && patch.oldMode !== patch.newMode
      ? [
          <p class="diff-header">
            File mode: {patch.oldMode} → {patch.newMode}
          </p>,
        ]
      : [],
  );
  const sourceChanged = difference.before !== difference.after || modeChanges.length > 0;
  const blocks = [
    ...rows,
    ...compared.rows.map((row) => ({
      unified: split ? null : markdownTokens(parser, row.unified),
      previous: split ? markdownTokens(previous, row.previous) : null,
      current: split ? markdownTokens(current, row.current) : null,
    })),
  ];
  const classes = "document-diff" + (split ? " split" : "");
  const scrollIndex = split ? 0 : undefined;
  const sourceOnly =
    sourceChanged && !modeChanges.length && !compared.changed && sameMetadata && !compared.referencesChanged;
  return (
    <section class="document-comparison">
      {modeChanges}
      {old.error || next.error ? <p class="notice">{old.error || next.error}</p> : null}
      {compared.coarse && <p class="notice">Some edited blocks are highlighted in full.</p>}
      {sourceOnly && <p class="notice">Only source formatting or comments changed.</p>}
      {!sourceOnly && !isDeepStrictEqual(old.comments, next.comments) && (
        <p class="notice">Frontmatter comments also changed.</p>
      )}
      {compared.referencesChanged && <p class="notice">Reference definitions changed.</p>}
      <section class={classes} aria-label="Document differences" tabIndex={scrollIndex}>
        {split ? (
          <table class="document-diff-table">
            <thead class="column-labels">
              <tr>
                <th scope="col" aria-label="Previous">
                  <span class="sr-only">Previous</span>
                </th>
                <th scope="col" aria-label="Current">
                  <span class="sr-only">Current</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((row) => (
                <tr>
                  <td data-diff-side="before">{row.previous}</td>
                  <td data-diff-side="after">{row.current}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          blocks.map((row) => row.unified)
        )}
      </section>
    </section>
  );
}
export function comparisonView(result: ComparisonResult, context: DifferenceContext, split = false): JSX.Element {
  return result.state === "unavailable" ? (
    <p class="notice">Source differences unavailable: {result.problem}</p>
  ) : (
    sourceDiffView(result.difference, context, split)
  );
}
