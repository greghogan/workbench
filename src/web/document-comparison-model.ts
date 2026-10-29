import { parseDocument, visit } from "yaml";
import { diffArrays } from "diff";
import { isDeepStrictEqual } from "node:util";
import { splitFrontmatter } from "../record-document.js";
import { metadataObject } from "../record-metadata.js";
import { compareDocuments, textChanges } from "./document-comparison.js";
import type { SourceDifference } from "./diff.js";
import type { MarkdownIt as MarkdownParser } from "markdown-it";

function fields(contents: string): {
  body: string;
  values: Record<string, unknown>;
  comments: string[];
  error: string;
} {
  const parts = splitFrontmatter(contents);
  if (!parts) return { body: contents, values: {}, comments: [], error: "" };
  try {
    const document = parseDocument(parts.yaml);
    if (document.errors.length) throw new Error("Invalid record fields");
    const values: unknown = document.toJS();
    if (!metadataObject(values)) throw new Error("Expected record fields");
    const comments: (string | null | undefined)[] = [document.commentBefore, document.comment];
    visit(document, {
      Node: (_key, node) => {
        comments.push(node.commentBefore, node.comment);
      },
    });
    return {
      body: parts.body,
      values,
      comments: comments.filter((comment): comment is string => !!comment),
      error: "",
    };
  } catch {
    return {
      body: parts.body,
      values: {},
      comments: [],
      error: "Record fields could not be parsed. Review the file using the command line.",
    };
  }
}
/** Preparation owns values and comparison decisions; rendering owns mutable Markdown renderer tokens. */
export function prepareDocumentComparison(difference: SourceDifference, pageTitle?: string, parser?: MarkdownParser) {
  const old = fields(difference.before),
    next = fields(difference.after);
  const changes = diffArrays(Object.keys(old.values), Object.keys(next.values), {
    timeout: 10,
    maxEditLength: 2048,
  }) ?? [{ value: Object.keys(old.values) }, { value: Object.keys(next.values) }];
  const keys = [...new Set(changes.flatMap((change) => change.value))];
  return {
    old,
    next,
    compared: compareDocuments(old.body, next.body, pageTitle, parser ? { parser } : {}),
    sameMetadata: isDeepStrictEqual(old.values, next.values),
    rows: keys.map((key) => {
      const before = old.values[key],
        after = next.values[key];
      return {
        key,
        before,
        after,
        same: isDeepStrictEqual(before, after),
        parts: typeof before === "string" && typeof after === "string" ? textChanges(before, after) : undefined,
      };
    }),
  };
}
