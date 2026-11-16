import { isUtf8 } from "node:buffer";
import type { JSX } from "preact";
import type { RecordLookup } from "../../core/records/record-lookup.js";
import { markdown, type MarkdownRecord } from "./markdown-view.js";
import { sourceDiffView } from "./diff-view.js";
import { codeDifference, type FileDifferenceOptions } from "./code-difference.js";

export function historyComparison(
  before: Buffer | undefined,
  after: Buffer | undefined,
  options: { path: string; split: boolean; tooLarge?: boolean } & (
    | ({ purpose: "file" } & FileDifferenceOptions)
    | { purpose: "record"; record: MarkdownRecord; references: RecordLookup }
  ),
): JSX.Element {
  if (options.tooLarge) return <p class="notice">File exceeds the preview limit; download and inspect it.</p>;
  if ([before, after].some((bytes) => bytes !== undefined && (bytes.includes(0) || !isUtf8(bytes))))
    return <p class="notice">Binary file: download and inspect it.</p>;
  const previous = before?.toString(),
    current = after?.toString();
  if (options.purpose === "file") return codeDifference(previous, current, options.split, options.path, options);
  if (options.path.endsWith(".md"))
    return before && after && previous !== current
      ? sourceDiffView(
          { patch: "", before: previous ?? "", after: current ?? "" },
          { record: options.record, records: options.references },
          options.split,
        )
      : markdown(current ?? previous ?? "", options.record, options.references);
  return codeDifference(previous, current, options.split, options.path, { context: "all" });
}
