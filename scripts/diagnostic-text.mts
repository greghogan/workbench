import { StringDecoder } from "node:string_decoder";
import { Transform, type TransformCallback, type Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";

export const credentialNames =
  "(?:authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|private[_-]?key|secret)";
export const safeText = (text: string) =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    /(?:TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION|CREDENTIAL)/i.test(key) &&
    value &&
    value.length >= 6 &&
    value.length <= 16384
      ? [value]
      : [],
  );
}
export function redact(text: string, secrets = secretValues()): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/https?:\/\/[^\s<>"']+/g, (text) => {
      try {
        const url = new URL(text);
        return url.origin + url.pathname;
      } catch {
        return "[invalid URL]";
      }
    })
    .replace(
      new RegExp(
        String.raw`\b(${credentialNames}["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;]+)`,
        "gi",
      ),
      (_all, prefix: string, value: string) =>
        prefix + (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"),
    );
}
export function clipped(text: string, maximum = 4096, secrets = secretValues()): { text: string; omitted: number } {
  return boundedText(safeText(redact(text, secrets)), maximum);
}
export function boundedText(text: string, maximum = 4096): { text: string; omitted: number } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return { text: bytes.toString(), omitted: 0 };
  const budget = Math.max(0, maximum - 64);
  let head = Math.floor(budget / 2),
    tail = bytes.length - (budget - head);
  while (head > 0 && ((bytes[head] ?? 0) & 0xc0) === 0x80) head--;
  while (tail < bytes.length && ((bytes[tail] ?? 0) & 0xc0) === 0x80) tail++;
  const omitted = tail - head;
  return {
    text: `${bytes.subarray(0, head).toString()}[${String(omitted)} diagnostic bytes omitted]${bytes.subarray(tail).toString()}`,
    omitted,
  };
}
/** Bounded UTF-8 head/tail capture counts every omitted byte, including oversized first chunks. */
export class DiagnosticCapture {
  private first = Buffer.alloc(0);
  private last = Buffer.alloc(0);
  private total = 0;
  constructor(private readonly limit = 65536) {
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > 1048576)
      throw new Error("diagnostic capture limit must be between 2 and 1048576 bytes");
  }
  add(bytes: Buffer): void {
    this.total += bytes.length;
    const head = Math.floor(this.limit / 2);
    if (this.first.length < head) {
      const take = Math.min(head - this.first.length, bytes.length);
      this.first = Buffer.concat([this.first, bytes.subarray(0, take)]);
      bytes = bytes.subarray(take);
    }
    const keep = this.limit - head;
    this.last = Buffer.concat([this.last, bytes.subarray(Math.max(0, bytes.length - keep))]).subarray(-keep);
  }
  text(): string {
    return redact(this.rawText());
  }
  /** Only structured decoders may use raw capture; display paths must call text(). */
  rawText(): string {
    const omitted = Math.max(0, this.total - this.first.length - this.last.length);
    if (!omitted) return Buffer.concat([this.first, this.last]).toString("utf8");
    let head = this.first.length,
      tail = 0;
    if (head) {
      let lead = head - 1;
      while (lead > 0 && ((this.first[lead] ?? 0) & 0xc0) === 0x80) lead--;
      const byte = this.first[lead] ?? 0;
      const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (head - lead < width) head = lead;
    }
    while (tail < this.last.length && ((this.last[tail] ?? 0) & 0xc0) === 0x80) tail++;
    const skipped = this.total - head - (this.last.length - tail);
    return (
      this.first.subarray(0, head).toString("utf8") +
      `\n[${String(skipped)} diagnostic bytes omitted]\n` +
      this.last.subarray(tail).toString("utf8")
    );
  }
  get bytes(): number {
    return this.total;
  }
}

/** Redact secrets across stream chunk boundaries without buffering an entire log. */
export class DiagnosticRedactor extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private readonly overlap: number;
  private readonly multiline: boolean;
  private continuation: "url" | "credential" | '"' | "'" | undefined;
  private escaped = false;
  constructor(private readonly secrets = secretValues()) {
    super();
    this.overlap = Math.max(4096, ...secrets.map((secret) => secret.length));
    this.multiline = secrets.some((secret) => secret.includes("\n"));
  }
  override _transform(bytes: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending += this.decoder.write(bytes);
    if (this.continuation) {
      let boundary = -1;
      if (this.continuation === '"' || this.continuation === "'") {
        for (let index = 0; index < this.pending.length; index++) {
          const character = this.pending[index];
          if (this.escaped) this.escaped = false;
          else if (character === "\\") this.escaped = true;
          else if (character === this.continuation) {
            boundary = index + 1;
            break;
          }
        }
      } else {
        boundary = (this.continuation === "url" ? /[\s<>"']/ : /[\s,;]/).exec(this.pending)?.index ?? -1;
      }
      if (boundary < 0) {
        this.pending = "";
        callback();
        return;
      }
      this.pending = this.pending.slice(boundary);
      this.continuation = undefined;
      this.escaped = false;
    }
    for (const secret of this.secrets) this.pending = this.pending.split(secret).join("[REDACTED]");
    const url = /https?:\/\/[^\s<>"']*$/.exec(this.pending);
    const credential = new RegExp(
      String.raw`\b${credentialNames}["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*\\?|'(?:\\[\s\S]|[^'\\])*\\?|(?:Bearer\s+)?[^\s,;"']*)$`,
      "i",
    ).exec(this.pending);
    const token = url && (!credential || url.index < credential.index) ? url : credential;
    if (token && token[0].length > this.overlap) {
      this.push(
        redact(this.pending.slice(0, token.index), this.secrets) + "[REDACTED: oversized token continuation omitted]",
      );
      const quote = token === credential ? /[:=]\s*(["'])/.exec(token[0])?.[1] : undefined;
      this.continuation = quote === '"' || quote === "'" ? quote : token === url ? "url" : "credential";
      this.escaped = (/\\+$/.exec(token[0])?.[0].length ?? 0) % 2 === 1;
      this.pending = "";
    } else {
      // Redact complete tokens before choosing a chunk boundary, while retaining incomplete tails verbatim.
      const prefix = redact(token ? this.pending.slice(0, token.index) : this.pending, this.secrets);
      this.pending = prefix + (token?.[0] ?? "");
      const newline = prefix.lastIndexOf("\n");
      const end = Math.min(
        prefix.length,
        newline >= 0 && !this.multiline ? newline + 1 : Math.max(0, this.pending.length - this.overlap),
      );
      this.push(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
    }
    callback();
  }
  override _flush(callback: TransformCallback): void {
    if (!this.continuation) this.push(redact(this.pending + this.decoder.end(), this.secrets));
    callback();
  }
}

/** Drain redacted bytes before closing a retained log; a failed sink must not stall the child process. */
export function retainDiagnosticStream(source: Readable, destination: Writable, secrets?: string[]): Promise<void> {
  const redactor = new DiagnosticRedactor(secrets);
  const fail = (error: Error) => {
    source.unpipe(redactor);
    redactor.unpipe(destination);
    redactor.destroy(error);
    source.resume();
  };
  const close = () => {
    if (!source.readableEnded) fail(new Error("Diagnostic source closed before its output was drained"));
  };
  source.on("error", fail);
  source.on("close", close);
  destination.on("error", fail);
  const completion = finished(redactor, { cleanup: true }).finally(() => {
    source.removeListener("error", fail);
    source.removeListener("close", close);
    destination.removeListener("error", fail);
  });
  source.pipe(redactor).pipe(destination, { end: false });
  return completion;
}
