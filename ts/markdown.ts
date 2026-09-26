import { readText, writeAtomic } from "./core.js";

export function proseWords(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let codeDelimiter = 0;
  let labelDepth = 0;
  let destinationDepth = 0;
  let previous = "";
  const characters = [...value];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!;
    if (character === "`") {
      let count = 1;
      while (characters[index + 1] === "`") {
        index++;
        count++;
      }
      word += "`".repeat(count);
      if (!codeDelimiter) codeDelimiter = count;
      else if (codeDelimiter === count) codeDelimiter = 0;
    } else if (!codeDelimiter && character === "[") {
      labelDepth++;
      word += character;
    } else if (!codeDelimiter && character === "]" && labelDepth > 0) {
      labelDepth--;
      word += character;
    } else if (!codeDelimiter && character === "(" && (previous === "]" || destinationDepth > 0)) {
      destinationDepth++;
      word += character;
    } else if (!codeDelimiter && character === ")" && destinationDepth > 0) {
      destinationDepth--;
      word += character;
    } else if (/\s/.test(character) && !codeDelimiter && !labelDepth && !destinationDepth) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else if (/\s/.test(character)) {
      if (!word.endsWith(" ")) word += " ";
    } else word += character;
    previous = character;
  }
  if (word) words.push(word);
  return words;
}

function marker(line: string): [string, number] | undefined {
  const match = /^(`{3,}|~{3,})/.exec(line);
  return match?.[1] ? [match[1][0]!, match[1].length] : undefined;
}

function ordinary(line: string): boolean {
  if (!line || /^\s/.test(line) || /(?: {2}|\\)$/.test(line) || "#-*+>|<`~[!".includes(line[0]!)) return false;
  if (/^\d+\./.test(line)) return false;
  return !["Summary:", "Agent instruction:", "Overrides:", "Status:", "Parent:", "Depends on:"].some(
    (prefix) => line === prefix || line.startsWith(`${prefix} `),
  );
}

export function wrapMarkdown(input: string, width: number): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let fence: [string, number] | undefined;
  const flush = () => {
    if (!paragraph.length) return;
    let line = "";
    for (const word of proseWords(paragraph.join(" "))) {
      if (line && [...line].length + 1 + [...word].length > width) {
        output.push(line);
        line = word;
      } else line += `${line ? " " : ""}${word}`;
    }
    output.push(line);
    paragraph = [];
  };
  for (const line of input.split("\n").slice(0, input.endsWith("\n") ? -1 : undefined)) {
    const found = marker(line);
    if (!fence && !found && ordinary(line)) paragraph.push(line);
    else {
      flush();
      output.push(line);
    }
    if (found) {
      if (!fence) fence = found;
      else if (found[0] === fence[0] && found[1] >= fence[1] && line.slice(found[1]).trim() === "") fence = undefined;
    }
  }
  flush();
  return output.join("\n") + (input.endsWith("\n") ? "\n" : "");
}

export function formatMarkdown(path: string, width: number, write = false): void {
  const original = readText(path);
  const formatted = wrapMarkdown(original, width);
  if (write) {
    if (formatted !== original) {
      writeAtomic(path, formatted);
      console.log(`Formatted ${path}`);
    }
  } else process.stdout.write(formatted);
}

export function markdownErrors(path: string, contents: string, width: number): string[] {
  const errors: string[] = [];
  let fence: [string, number] | undefined;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.replace(/^ +/, "");
    const indentation = line.length - trimmed.length;
    const found = indentation <= 3 ? marker(trimmed) : undefined;
    if (found) {
      if (!fence) fence = found;
      else if (fence[0] === found[0] && found[1] >= fence[1] && trimmed.slice(found[1]).trim() === "")
        fence = undefined;
      continue;
    }
    if (
      fence ||
      indentation >= 4 ||
      line.startsWith("\t") ||
      trimmed.startsWith("|") ||
      line.includes(" | ") ||
      proseWords(line).some((word) => [...word].length > width)
    )
      continue;
    const length = [...line].length;
    if (length > width) errors.push(`${path}:${index + 1}: prose line is ${length} characters (maximum ${width})`);
  }
  return errors;
}
