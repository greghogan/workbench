import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { redact } from "./diagnostics.js";
import { safeOutput } from "./terminal-output.js";

interface LogLine {
  index: number;
  text: string;
}

/** Selection is independent of file I/O and never grows with the input log. */
class DiagnosticContext {
  readonly lines = new Map<number, LogLine>();
  private following = 0;
  constructor(private readonly limit: number) {}
  consume(line: LogLine, diagnostic: boolean, previous: LogLine | undefined): void {
    if (diagnostic && this.lines.size < this.limit - 2) {
      if (previous) this.lines.set(previous.index, previous);
      this.lines.set(line.index, line);
      this.following = 2;
    } else if (this.following > 0 && this.lines.size < this.limit) {
      this.lines.set(line.index, line);
      this.following--;
    }
  }
}

class FailureCollector {
  private readonly head: LogLine[] = [];
  private readonly tail: LogLine[] = [];
  private readonly source = new DiagnosticContext(12);
  private readonly general = new DiagnosticContext(8);
  private index = 0;
  private previous: LogLine | undefined;
  truncated = false;

  constructor(private readonly omit: (line: string) => boolean) {}
  consume(text: string): void {
    if (this.omit(text)) return;
    const line = { index: this.index++, text: safeOutput(text.replace(/[\uD800-\uDBFF]$/, "")) };
    if (this.head.length < 4) this.head.push(line);
    this.tail.push(line);
    if (this.tail.length > 10) this.tail.shift();
    const source = /(?:\.(?:java|[cm]?[jt]sx?|[ch](?:pp|xx)?|rs|go|py|rb|php):(?:\d|\[\d)|^\s*-->\s*\S+:\d+)/i.test(
      line.text,
    );
    const diagnostic =
      /(?:\b(?:warning|error|fatal)(?:\[[^\]]+\])?:|\[(?:WARNING|ERROR)\]|^\s*(?:Caused by:|AssertionError|Error:))/i.test(
        line.text,
      ) && !/warnings found and -Werror|BUILD FAILURE|compilation failure/i.test(line.text);
    // Source locations have their own budget so a warning flood cannot hide the compiler's cause.
    this.source.consume(line, source, this.previous);
    this.general.consume(line, diagnostic && !source, this.previous);
    this.previous = line;
  }
  render(): string {
    const chosen = new Map<number, LogLine>();
    const select = (candidates: Iterable<LogLine>, budget: number, perLine: number) => {
      for (const line of candidates) {
        const text = Buffer.from(redact(line.text))
          .subarray(0, Math.max(0, Math.min(perLine, budget)))
          .toString("utf8")
          .replace(/\uFFFD$/, "");
        this.truncated ||= text !== line.text;
        if (!text && line.text) continue;
        const previous = chosen.get(line.index);
        if (!previous || previous.text.length < text.length) chosen.set(line.index, { ...line, text });
        budget -= Buffer.byteLength(text) + 1;
      }
    };
    select(this.source.lines.values(), 2800, 768);
    select(this.general.lines.values(), 1000, 384);
    select([...this.tail].reverse(), 2200, 512);
    select(this.head, 600, 175);
    const selected = [...chosen.values()].sort((a, b) => a.index - b.index);
    let last = -1;
    const lines: string[] = [];
    for (const line of selected) {
      if (line.index !== last + 1) lines.push("[Middle output omitted; see the retained log.]");
      lines.push(line.text);
      last = line.index;
    }
    return `${this.truncated || selected.length < this.index ? "Earlier output omitted; see the full log.\n" : ""}${lines.join("\n")}\n`;
  }
}

/** Scan failed logs with bounded UTF-8 lines, while allowing cancellation to close the input promptly. */
export async function failureExcerpt(
  path: string,
  omit: (line: string) => boolean,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const collector = new FailureCollector(omit);
  const file = await open(path, "r");
  try {
    signal?.throwIfAborted();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
      ...(signal ? { signal } : {}),
    })) {
      signal?.throwIfAborted();
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        collector.truncated ||= pending.length + end - start > 4096;
        collector.consume((pending + text.slice(start, end).slice(0, 4096 - pending.length)).replace(/\r$/, ""));
        pending = "";
        start = end + 1;
      }
      const remainder = text.slice(start);
      collector.truncated ||= pending.length + remainder.length > 4096;
      pending += remainder.slice(0, 4096 - pending.length);
    }
    const final = decoder.end();
    collector.truncated ||= pending.length + final.length > 4096;
    pending += final.slice(0, 4096 - pending.length);
    if (pending) collector.consume(pending);
    signal?.throwIfAborted();
  } finally {
    await file.close();
  }
  return collector.render();
}
