import MarkdownIt from "markdown-it";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
const parser = new MarkdownIt({ html: true });

/** Encode a filesystem path as one Markdown link destination, without inventing a fragment or query. */
export function markdownPath(path: string): string {
  return encodeURI(path.split(sep).join("/"))
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

export function markdownLabel(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&");
}

/** CommonMark resolves reference definitions and excludes code examples and comments. */
export function markdownLinks(contents: string): string[] {
  return parser.parse(contents, {}).flatMap((block) =>
    (block.children ?? []).flatMap((token) => {
      const href =
        token.type === "link_open" ? token.attrGet("href") : token.type === "image" ? token.attrGet("src") : null;
      return typeof href === "string" && href ? [href] : [];
    }),
  );
}

/** Literal examples are source text, not links or task steps to interpret and rewrite. */
export function markdownLiteralLines(contents: string): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const token of parser.parse(contents, {}))
    if (["fence", "code_block", "html_block"].includes(token.type) && token.map)
      for (let line = token.map[0]; line < token.map[1]; line++) lines.add(line);
  return lines;
}

/** Relocate link destinations without reserializing human-authored Markdown or touching code examples. */
export function relocateMarkdownLinks(contents: string, source: string, destination: string, absolute = false): string {
  const lines = contents.split(/(?<=\n)/);
  const code = markdownLiteralLines(contents);
  const target = (href: string): string => {
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) || isAbsolute(href)) return href;
    const match = /^([^?#]*)([?#].*)?$/.exec(href);
    if (!match) return href;
    let path: string;
    try {
      path = decodeURIComponent(match[1] ?? "").replace(/\\([() ])/g, "$1");
    } catch {
      return href;
    }
    const resolved = path ? resolve(dirname(source), path) : source;
    const relocated = absolute ? resolved : relative(dirname(destination), resolved);
    return markdownPath(relocated) + (match[2] ?? "");
  };
  return lines
    .map((line, lineNumber) => {
      if (code.has(lineNumber)) return line;
      const edits: { start: number; end: number; value: string }[] = [];
      const replace = (start: number, end: number) => {
        const href = line.slice(start, end);
        const value = target(href);
        if (href !== value) edits.push({ start, end, value });
      };
      const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/.exec(line);
      if (definition?.[1]) {
        const start = line.indexOf(definition[1], definition[0].indexOf(":") + 1);
        replace(
          start + (definition[1].startsWith("<") ? 1 : 0),
          start + definition[1].length - (definition[1].endsWith(">") ? 1 : 0),
        );
      } else {
        for (let index = 0; index < line.length; index++) {
          if (line[index] === "\\") {
            index++;
            continue;
          }
          if (line[index] === "`") {
            let end = index + 1;
            while (line[end] === "`") end++;
            const closing = line.indexOf(line.slice(index, end), end);
            index = closing < 0 ? end - 1 : closing + end - index - 1;
            continue;
          }
          if (line[index] !== "]" || line[index + 1] !== "(" || line.lastIndexOf("[", index) < 0) continue;
          let start = index + 2;
          while (/\s/.test(line[start] ?? "") && start < line.length) start++;
          const angle = line[start] === "<";
          if (angle) start++;
          let end = start,
            depth = 0;
          for (; end < line.length; end++) {
            const character = line[end];
            if (character === "\\") {
              end++;
              continue;
            }
            if (angle) {
              if (character === ">") break;
            } else if (character === "(") depth++;
            else if (character === ")") {
              if (!depth) break;
              depth--;
            } else if (/\s/.test(character ?? "")) break;
          }
          if (end < line.length) replace(start, end);
          index = end;
        }
      }
      for (const edit of edits.reverse()) line = line.slice(0, edit.start) + edit.value + line.slice(edit.end);
      return line;
    })
    .join("");
}
