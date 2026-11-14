import { diffLines } from "diff";
import type { JSX } from "preact";

/** Literal file contents stay escaped; jsdiff aligns lines without interpreting source as markup. */
export function codeDifference(before: string | undefined, after: string | undefined, split: boolean): JSX.Element {
  if (before === undefined || after === undefined || before === after)
    return <pre class="source">{after ?? before ?? ""}</pre>;
  const changes = diffLines(before, after, { maxEditLength: 4000 }),
    parts = (side?: "before" | "after") =>
      changes?.map((part) => {
        if ((side === "before" && part.added) || (side === "after" && part.removed)) return null;
        const Tag = part.added ? "ins" : part.removed ? "del" : "span";
        return <Tag>{part.value}</Tag>;
      });
  const columns = (
    <div class="code-comparison">
      <pre class="source" aria-label="Previous file">
        {changes ? parts("before") : before}
      </pre>
      <pre class="source" aria-label="Current file">
        {changes ? parts("after") : after}
      </pre>
    </div>
  );
  if (!changes)
    return (
      <>
        <p class="notice">Showing both complete files; detailed line matching is unavailable.</p>
        {columns}
      </>
    );
  return split ? (
    columns
  ) : (
    <pre class="source code-difference" aria-label="File changes">
      {parts()}
    </pre>
  );
}
