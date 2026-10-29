// Generated from diagnostic-text.mts; edit the TypeScript source.
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";
const credentialNames = "(?:authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|private[_-]?key|secret)";
const safeText = (text) => stripVTControlCharacters(text).replace(/\p{Cc}/gu, (c) => c === "\n" || c === "	" ? c : "");
let measureWidth = (text) => Buffer.byteLength(text);
const textWidth = (text) => measureWidth(text.replaceAll("	", "        "));
function setDiagnosticTextWidth(measure) {
  const previous = measureWidth;
  measureWidth = measure;
  return () => {
    measureWidth = previous;
  };
}
const diagnosticColumns = (columns) => columns !== void 0 && Number.isSafeInteger(columns) && columns > 0 ? Math.min(80, columns) : 80;
function wrapDiagnosticText(text, columns = process.stderr.columns) {
  const width = diagnosticColumns(columns);
  const sources = safeText(text).split("\n");
  const frames = /* @__PURE__ */ new Set();
  for (const [index, source] of sources.entries()) {
    if (/^\s*(?:\|\s*)?[\^~]+(?:\s.*)?$/u.test(source)) {
      frames.add(index);
      if (index > 0) frames.add(index - 1);
    }
    if (/^\s*(?:>\s*)?\d+\s*\||^\s*\|/u.test(source)) frames.add(index);
  }
  return sources.flatMap((source, index) => {
    if (frames.has(index) || textWidth(source) <= width) return [source];
    const indent = /^[ \t]*/u.exec(source)?.[0] ?? "";
    const continuation = indent || "  ";
    const lines = [];
    let line = "", offset = 0;
    for (const word of source.matchAll(/'(?:[^']|'\\'')*'\S*|"(?:\\.|[^"\\])*"\S*|`[^`]*`\S*|\S+/gu)) {
      const gap = source.slice(offset, word.index);
      if (offset > 0 && textWidth(line + gap + word[0]) > width) {
        lines.push(line);
        line = continuation + word[0];
      } else line += gap + word[0];
      offset = word.index + word[0].length;
    }
    lines.push(line + source.slice(offset));
    return lines;
  }).join("\n");
}
function formatDiagnosticSections({ summary, groups = [], next }) {
  return [
    summary,
    ...groups.filter((group) => group.items.length).map(({ heading, items }) => `${heading}:
${items.map((item) => `  - ${item}`).join("\n")}`),
    next
  ].filter((paragraph) => paragraph !== void 0 && paragraph !== "").join("\n\n");
}
function formatDiagnosticMessage(header, message, columns = process.stderr.columns) {
  const text = `${header} ${message}`;
  return wrapDiagnosticText(
    message.includes("\n") || textWidth(text) > diagnosticColumns(columns) ? `${header}

${message.split("\n").map((line) => line ? `  ${line}` : "").join("\n")}` : text,
    columns
  );
}
function secretValues(env = process.env) {
  return Object.entries(env).flatMap(
    ([key, value]) => /(?:TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION|CREDENTIAL)/i.test(key) && value && value.length >= 6 && value.length <= 16384 ? [value] : []
  );
}
function redact(text, secrets = secretValues()) {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[REDACTED]");
  return result.replace(/https?:\/\/[^\s<>"']+/g, (text2) => {
    try {
      const url = new URL(text2);
      return url.origin + url.pathname;
    } catch {
      return "[invalid URL]";
    }
  }).replace(
    new RegExp(
      String.raw`\b(${credentialNames}["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;]+)`,
      "gi"
    ),
    (_all, prefix, value) => prefix + (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]")
  );
}
function clipped(text, maximum = 4096, secrets = secretValues()) {
  return boundedText(safeText(redact(text, secrets)), maximum);
}
function boundedText(text, maximum = 4096) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return { text: bytes.toString(), omitted: 0 };
  const budget = Math.max(0, maximum - 64);
  let head = Math.floor(budget / 2), tail = bytes.length - (budget - head);
  while (head > 0 && ((bytes[head] ?? 0) & 192) === 128) head--;
  while (tail < bytes.length && ((bytes[tail] ?? 0) & 192) === 128) tail++;
  const omitted = tail - head;
  return {
    text: `${bytes.subarray(0, head).toString()}[${String(omitted)} diagnostic bytes omitted]${bytes.subarray(tail).toString()}`,
    omitted
  };
}
class DiagnosticCapture {
  constructor(limit = 65536) {
    this.limit = limit;
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > 1048576)
      throw new Error("diagnostic capture limit must be between 2 and 1048576 bytes");
  }
  limit;
  first = Buffer.alloc(0);
  last = Buffer.alloc(0);
  total = 0;
  add(bytes) {
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
  text() {
    return redact(this.rawText());
  }
  /** Only structured decoders may use raw capture; display paths must call text(). */
  rawText() {
    const omitted = Math.max(0, this.total - this.first.length - this.last.length);
    if (!omitted) return Buffer.concat([this.first, this.last]).toString("utf8");
    let head = this.first.length, tail = 0;
    if (head) {
      let lead = head - 1;
      while (lead > 0 && ((this.first[lead] ?? 0) & 192) === 128) lead--;
      const byte = this.first[lead] ?? 0;
      const width = byte < 128 ? 1 : byte < 224 ? 2 : byte < 240 ? 3 : 4;
      if (head - lead < width) head = lead;
    }
    while (tail < this.last.length && ((this.last[tail] ?? 0) & 192) === 128) tail++;
    const skipped = this.total - head - (this.last.length - tail);
    return this.first.subarray(0, head).toString("utf8") + `
[${String(skipped)} diagnostic bytes omitted]
` + this.last.subarray(tail).toString("utf8");
  }
  get bytes() {
    return this.total;
  }
}
class DiagnosticRedactor extends Transform {
  constructor(secrets = secretValues()) {
    super();
    this.secrets = secrets;
    this.overlap = Math.max(4096, ...secrets.map((secret) => secret.length));
    this.multiline = secrets.some((secret) => secret.includes("\n"));
  }
  secrets;
  decoder = new StringDecoder("utf8");
  pending = "";
  overlap;
  multiline;
  continuation;
  escaped = false;
  _transform(bytes, _encoding, callback) {
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
      this.continuation = void 0;
      this.escaped = false;
    }
    for (const secret of this.secrets) this.pending = this.pending.split(secret).join("[REDACTED]");
    const url = /https?:\/\/[^\s<>"']*$/.exec(this.pending);
    const credential = new RegExp(
      String.raw`\b${credentialNames}["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*\\?|'(?:\\[\s\S]|[^'\\])*\\?|(?:Bearer\s+)?[^\s,;"']*)$`,
      "i"
    ).exec(this.pending);
    const token = url && (!credential || url.index < credential.index) ? url : credential;
    if (token && token[0].length > this.overlap) {
      this.push(
        redact(this.pending.slice(0, token.index), this.secrets) + "[REDACTED: oversized token continuation omitted]"
      );
      const quote = token === credential ? /[:=]\s*(["'])/.exec(token[0])?.[1] : void 0;
      this.continuation = quote === '"' || quote === "'" ? quote : token === url ? "url" : "credential";
      this.escaped = (/\\+$/.exec(token[0])?.[0].length ?? 0) % 2 === 1;
      this.pending = "";
    } else {
      const prefix = redact(token ? this.pending.slice(0, token.index) : this.pending, this.secrets);
      this.pending = prefix + (token?.[0] ?? "");
      const newline = prefix.lastIndexOf("\n");
      const end = Math.min(
        prefix.length,
        newline >= 0 && !this.multiline ? newline + 1 : Math.max(0, this.pending.length - this.overlap)
      );
      this.push(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
    }
    callback();
  }
  _flush(callback) {
    if (!this.continuation) this.push(redact(this.pending + this.decoder.end(), this.secrets));
    callback();
  }
}
function retainDiagnosticStream(source, destination, secrets) {
  const redactor = new DiagnosticRedactor(secrets);
  const fail = (error) => {
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
export {
  DiagnosticCapture,
  DiagnosticRedactor,
  boundedText,
  clipped,
  credentialNames,
  formatDiagnosticMessage,
  formatDiagnosticSections,
  redact,
  retainDiagnosticStream,
  safeText,
  secretValues,
  setDiagnosticTextWidth,
  wrapDiagnosticText
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRpYWdub3N0aWMtdGV4dC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RyaW5nRGVjb2RlciB9IGZyb20gXCJub2RlOnN0cmluZ19kZWNvZGVyXCI7XG5pbXBvcnQgeyBUcmFuc2Zvcm0sIHR5cGUgVHJhbnNmb3JtQ2FsbGJhY2ssIHR5cGUgUmVhZGFibGUsIHR5cGUgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IGZpbmlzaGVkIH0gZnJvbSBcIm5vZGU6c3RyZWFtL3Byb21pc2VzXCI7XG5pbXBvcnQgeyBzdHJpcFZUQ29udHJvbENoYXJhY3RlcnMgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5cbmV4cG9ydCBjb25zdCBjcmVkZW50aWFsTmFtZXMgPVxuICBcIig/OmF1dGhvcml6YXRpb258cGFzc3dvcmR8YXBpW18tXT9rZXl8YWNjZXNzW18tXT90b2tlbnxyZWZyZXNoW18tXT90b2tlbnxpZFtfLV0/dG9rZW58dG9rZW58Y2xpZW50W18tXT9zZWNyZXR8cHJpdmF0ZVtfLV0/a2V5fHNlY3JldClcIjtcbmV4cG9ydCBjb25zdCBzYWZlVGV4dCA9ICh0ZXh0OiBzdHJpbmcpID0+XG4gIHN0cmlwVlRDb250cm9sQ2hhcmFjdGVycyh0ZXh0KS5yZXBsYWNlKC9cXHB7Q2N9L2d1LCAoYykgPT4gKGMgPT09IFwiXFxuXCIgfHwgYyA9PT0gXCJcXHRcIiA/IGMgOiBcIlwiKSk7XG5cbi8vIEJvb3RzdHJhcCBjYW5ub3QgbG9hZCB0aGUgbW9kZXJuIHRlcm1pbmFsLXdpZHRoIGRlcGVuZGVuY3kuIFVURi04IGJ5dGVzIHByb3ZpZGUgYSBjb25zZXJ2YXRpdmUgd2lkdGggdGhlcmUuXG5sZXQgbWVhc3VyZVdpZHRoID0gKHRleHQ6IHN0cmluZykgPT4gQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCk7XG5jb25zdCB0ZXh0V2lkdGggPSAodGV4dDogc3RyaW5nKSA9PiBtZWFzdXJlV2lkdGgodGV4dC5yZXBsYWNlQWxsKFwiXFx0XCIsIFwiICAgICAgICBcIikpO1xuZXhwb3J0IGZ1bmN0aW9uIHNldERpYWdub3N0aWNUZXh0V2lkdGgobWVhc3VyZTogKHRleHQ6IHN0cmluZykgPT4gbnVtYmVyKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHByZXZpb3VzID0gbWVhc3VyZVdpZHRoO1xuICBtZWFzdXJlV2lkdGggPSBtZWFzdXJlO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIG1lYXN1cmVXaWR0aCA9IHByZXZpb3VzO1xuICB9O1xufVxuY29uc3QgZGlhZ25vc3RpY0NvbHVtbnMgPSAoY29sdW1uczogbnVtYmVyIHwgdW5kZWZpbmVkKSA9PlxuICBjb2x1bW5zICE9PSB1bmRlZmluZWQgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIoY29sdW1ucykgJiYgY29sdW1ucyA+IDAgPyBNYXRoLm1pbig4MCwgY29sdW1ucykgOiA4MDtcblxuLyoqIFdyYXAgcHJvc2UgYXQgd29yZCBib3VuZGFyaWVzOyB2YWx1ZXMgYW5kIHNvdXJjZSBmcmFtZXMgcmV0YWluIHRoZWlyIGV4YWN0IGNvbnRlbnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyYXBEaWFnbm9zdGljVGV4dCh0ZXh0OiBzdHJpbmcsIGNvbHVtbnMgPSBwcm9jZXNzLnN0ZGVyci5jb2x1bW5zKTogc3RyaW5nIHtcbiAgY29uc3Qgd2lkdGggPSBkaWFnbm9zdGljQ29sdW1ucyhjb2x1bW5zKTtcbiAgY29uc3Qgc291cmNlcyA9IHNhZmVUZXh0KHRleHQpLnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBmcmFtZXMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBbaW5kZXgsIHNvdXJjZV0gb2Ygc291cmNlcy5lbnRyaWVzKCkpIHtcbiAgICBpZiAoL15cXHMqKD86XFx8XFxzKik/W1xcXn5dKyg/Olxccy4qKT8kL3UudGVzdChzb3VyY2UpKSB7XG4gICAgICBmcmFtZXMuYWRkKGluZGV4KTtcbiAgICAgIGlmIChpbmRleCA+IDApIGZyYW1lcy5hZGQoaW5kZXggLSAxKTtcbiAgICB9XG4gICAgaWYgKC9eXFxzKig/Oj5cXHMqKT9cXGQrXFxzKlxcfHxeXFxzKlxcfC91LnRlc3Qoc291cmNlKSkgZnJhbWVzLmFkZChpbmRleCk7XG4gIH1cbiAgcmV0dXJuIHNvdXJjZXNcbiAgICAuZmxhdE1hcCgoc291cmNlLCBpbmRleCkgPT4ge1xuICAgICAgaWYgKGZyYW1lcy5oYXMoaW5kZXgpIHx8IHRleHRXaWR0aChzb3VyY2UpIDw9IHdpZHRoKSByZXR1cm4gW3NvdXJjZV07XG4gICAgICBjb25zdCBpbmRlbnQgPSAvXlsgXFx0XSovdS5leGVjKHNvdXJjZSk/LlswXSA/PyBcIlwiO1xuICAgICAgY29uc3QgY29udGludWF0aW9uID0gaW5kZW50IHx8IFwiICBcIjtcbiAgICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgbGV0IGxpbmUgPSBcIlwiLFxuICAgICAgICBvZmZzZXQgPSAwO1xuICAgICAgZm9yIChjb25zdCB3b3JkIG9mIHNvdXJjZS5tYXRjaEFsbCgvJyg/OlteJ118J1xcXFwnJykqJ1xcUyp8XCIoPzpcXFxcLnxbXlwiXFxcXF0pKlwiXFxTKnxgW15gXSpgXFxTKnxcXFMrL2d1KSkge1xuICAgICAgICBjb25zdCBnYXAgPSBzb3VyY2Uuc2xpY2Uob2Zmc2V0LCB3b3JkLmluZGV4KTtcbiAgICAgICAgaWYgKG9mZnNldCA+IDAgJiYgdGV4dFdpZHRoKGxpbmUgKyBnYXAgKyB3b3JkWzBdKSA+IHdpZHRoKSB7XG4gICAgICAgICAgbGluZXMucHVzaChsaW5lKTtcbiAgICAgICAgICBsaW5lID0gY29udGludWF0aW9uICsgd29yZFswXTtcbiAgICAgICAgfSBlbHNlIGxpbmUgKz0gZ2FwICsgd29yZFswXTtcbiAgICAgICAgb2Zmc2V0ID0gd29yZC5pbmRleCArIHdvcmRbMF0ubGVuZ3RoO1xuICAgICAgfVxuICAgICAgbGluZXMucHVzaChsaW5lICsgc291cmNlLnNsaWNlKG9mZnNldCkpO1xuICAgICAgcmV0dXJuIGxpbmVzO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcXG5cIik7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlhZ25vc3RpY01lc3NhZ2Uge1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIGdyb3Vwcz86IHJlYWRvbmx5IHsgaGVhZGluZzogc3RyaW5nOyBpdGVtczogcmVhZG9ubHkgc3RyaW5nW10gfVtdO1xuICBuZXh0Pzogc3RyaW5nO1xufVxuXG4vKiogS2VlcCB0aGUgc3VtbWFyeSwgYWZmZWN0ZWQgaXRlbXMsIGFuZCByZWNvdmVyeSBhY3Rpb24gaW4gc2VwYXJhdGUgcGFyYWdyYXBocy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREaWFnbm9zdGljU2VjdGlvbnMoeyBzdW1tYXJ5LCBncm91cHMgPSBbXSwgbmV4dCB9OiBEaWFnbm9zdGljTWVzc2FnZSk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgc3VtbWFyeSxcbiAgICAuLi5ncm91cHNcbiAgICAgIC5maWx0ZXIoKGdyb3VwKSA9PiBncm91cC5pdGVtcy5sZW5ndGgpXG4gICAgICAubWFwKCh7IGhlYWRpbmcsIGl0ZW1zIH0pID0+IGAke2hlYWRpbmd9OlxcbiR7aXRlbXMubWFwKChpdGVtKSA9PiBgICAtICR7aXRlbX1gKS5qb2luKFwiXFxuXCIpfWApLFxuICAgIG5leHQsXG4gIF1cbiAgICAuZmlsdGVyKChwYXJhZ3JhcGgpID0+IHBhcmFncmFwaCAhPT0gdW5kZWZpbmVkICYmIHBhcmFncmFwaCAhPT0gXCJcIilcbiAgICAuam9pbihcIlxcblxcblwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERpYWdub3N0aWNNZXNzYWdlKGhlYWRlcjogc3RyaW5nLCBtZXNzYWdlOiBzdHJpbmcsIGNvbHVtbnMgPSBwcm9jZXNzLnN0ZGVyci5jb2x1bW5zKTogc3RyaW5nIHtcbiAgY29uc3QgdGV4dCA9IGAke2hlYWRlcn0gJHttZXNzYWdlfWA7XG4gIHJldHVybiB3cmFwRGlhZ25vc3RpY1RleHQoXG4gICAgbWVzc2FnZS5pbmNsdWRlcyhcIlxcblwiKSB8fCB0ZXh0V2lkdGgodGV4dCkgPiBkaWFnbm9zdGljQ29sdW1ucyhjb2x1bW5zKVxuICAgICAgPyBgJHtoZWFkZXJ9XFxuXFxuJHttZXNzYWdlXG4gICAgICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAgICAgLm1hcCgobGluZSkgPT4gKGxpbmUgPyBgICAke2xpbmV9YCA6IFwiXCIpKVxuICAgICAgICAgIC5qb2luKFwiXFxuXCIpfWBcbiAgICAgIDogdGV4dCxcbiAgICBjb2x1bW5zLFxuICApO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlY3JldFZhbHVlcyhlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ID0gcHJvY2Vzcy5lbnYpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBPYmplY3QuZW50cmllcyhlbnYpLmZsYXRNYXAoKFtrZXksIHZhbHVlXSkgPT5cbiAgICAvKD86VE9LRU58UEFTU1dPUkR8U0VDUkVUfEFQSV9LRVl8QVVUSE9SSVpBVElPTnxDUkVERU5USUFMKS9pLnRlc3Qoa2V5KSAmJlxuICAgIHZhbHVlICYmXG4gICAgdmFsdWUubGVuZ3RoID49IDYgJiZcbiAgICB2YWx1ZS5sZW5ndGggPD0gMTYzODRcbiAgICAgID8gW3ZhbHVlXVxuICAgICAgOiBbXSxcbiAgKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiByZWRhY3QodGV4dDogc3RyaW5nLCBzZWNyZXRzID0gc2VjcmV0VmFsdWVzKCkpOiBzdHJpbmcge1xuICBsZXQgcmVzdWx0ID0gdGV4dDtcbiAgZm9yIChjb25zdCBzZWNyZXQgb2YgWy4uLnNlY3JldHNdLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpKVxuICAgIHJlc3VsdCA9IHJlc3VsdC5zcGxpdChzZWNyZXQpLmpvaW4oXCJbUkVEQUNURURdXCIpO1xuICByZXR1cm4gcmVzdWx0XG4gICAgLnJlcGxhY2UoL2h0dHBzPzpcXC9cXC9bXlxcczw+XCInXSsvZywgKHRleHQpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwodGV4dCk7XG4gICAgICAgIHJldHVybiB1cmwub3JpZ2luICsgdXJsLnBhdGhuYW1lO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBcIltpbnZhbGlkIFVSTF1cIjtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5yZXBsYWNlKFxuICAgICAgbmV3IFJlZ0V4cChcbiAgICAgICAgU3RyaW5nLnJhd2BcXGIoJHtjcmVkZW50aWFsTmFtZXN9W1wiJ10/XFxzKls6PV1cXHMqKShcIig/OlxcXFwufFteXCJcXFxcXSkqXCJ8Jyg/OlxcXFwufFteJ1xcXFxdKSonfCg/OkJlYXJlclxccyspP1teXFxzLDtdKylgLFxuICAgICAgICBcImdpXCIsXG4gICAgICApLFxuICAgICAgKF9hbGwsIHByZWZpeDogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSA9PlxuICAgICAgICBwcmVmaXggKyAodmFsdWUuc3RhcnRzV2l0aCgnXCInKSA/ICdcIltSRURBQ1RFRF1cIicgOiB2YWx1ZS5zdGFydHNXaXRoKFwiJ1wiKSA/IFwiJ1tSRURBQ1RFRF0nXCIgOiBcIltSRURBQ1RFRF1cIiksXG4gICAgKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBjbGlwcGVkKHRleHQ6IHN0cmluZywgbWF4aW11bSA9IDQwOTYsIHNlY3JldHMgPSBzZWNyZXRWYWx1ZXMoKSk6IHsgdGV4dDogc3RyaW5nOyBvbWl0dGVkOiBudW1iZXIgfSB7XG4gIHJldHVybiBib3VuZGVkVGV4dChzYWZlVGV4dChyZWRhY3QodGV4dCwgc2VjcmV0cykpLCBtYXhpbXVtKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBib3VuZGVkVGV4dCh0ZXh0OiBzdHJpbmcsIG1heGltdW0gPSA0MDk2KTogeyB0ZXh0OiBzdHJpbmc7IG9taXR0ZWQ6IG51bWJlciB9IHtcbiAgY29uc3QgYnl0ZXMgPSBCdWZmZXIuZnJvbSh0ZXh0KTtcbiAgaWYgKGJ5dGVzLmxlbmd0aCA8PSBtYXhpbXVtKSByZXR1cm4geyB0ZXh0OiBieXRlcy50b1N0cmluZygpLCBvbWl0dGVkOiAwIH07XG4gIGNvbnN0IGJ1ZGdldCA9IE1hdGgubWF4KDAsIG1heGltdW0gLSA2NCk7XG4gIGxldCBoZWFkID0gTWF0aC5mbG9vcihidWRnZXQgLyAyKSxcbiAgICB0YWlsID0gYnl0ZXMubGVuZ3RoIC0gKGJ1ZGdldCAtIGhlYWQpO1xuICB3aGlsZSAoaGVhZCA+IDAgJiYgKChieXRlc1toZWFkXSA/PyAwKSAmIDB4YzApID09PSAweDgwKSBoZWFkLS07XG4gIHdoaWxlICh0YWlsIDwgYnl0ZXMubGVuZ3RoICYmICgoYnl0ZXNbdGFpbF0gPz8gMCkgJiAweGMwKSA9PT0gMHg4MCkgdGFpbCsrO1xuICBjb25zdCBvbWl0dGVkID0gdGFpbCAtIGhlYWQ7XG4gIHJldHVybiB7XG4gICAgdGV4dDogYCR7Ynl0ZXMuc3ViYXJyYXkoMCwgaGVhZCkudG9TdHJpbmcoKX1bJHtTdHJpbmcob21pdHRlZCl9IGRpYWdub3N0aWMgYnl0ZXMgb21pdHRlZF0ke2J5dGVzLnN1YmFycmF5KHRhaWwpLnRvU3RyaW5nKCl9YCxcbiAgICBvbWl0dGVkLFxuICB9O1xufVxuLyoqIEJvdW5kZWQgVVRGLTggaGVhZC90YWlsIGNhcHR1cmUgY291bnRzIGV2ZXJ5IG9taXR0ZWQgYnl0ZSwgaW5jbHVkaW5nIG92ZXJzaXplZCBmaXJzdCBjaHVua3MuICovXG5leHBvcnQgY2xhc3MgRGlhZ25vc3RpY0NhcHR1cmUge1xuICBwcml2YXRlIGZpcnN0ID0gQnVmZmVyLmFsbG9jKDApO1xuICBwcml2YXRlIGxhc3QgPSBCdWZmZXIuYWxsb2MoMCk7XG4gIHByaXZhdGUgdG90YWwgPSAwO1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGxpbWl0ID0gNjU1MzYpIHtcbiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGxpbWl0KSB8fCBsaW1pdCA8IDIgfHwgbGltaXQgPiAxMDQ4NTc2KVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZGlhZ25vc3RpYyBjYXB0dXJlIGxpbWl0IG11c3QgYmUgYmV0d2VlbiAyIGFuZCAxMDQ4NTc2IGJ5dGVzXCIpO1xuICB9XG4gIGFkZChieXRlczogQnVmZmVyKTogdm9pZCB7XG4gICAgdGhpcy50b3RhbCArPSBieXRlcy5sZW5ndGg7XG4gICAgY29uc3QgaGVhZCA9IE1hdGguZmxvb3IodGhpcy5saW1pdCAvIDIpO1xuICAgIGlmICh0aGlzLmZpcnN0Lmxlbmd0aCA8IGhlYWQpIHtcbiAgICAgIGNvbnN0IHRha2UgPSBNYXRoLm1pbihoZWFkIC0gdGhpcy5maXJzdC5sZW5ndGgsIGJ5dGVzLmxlbmd0aCk7XG4gICAgICB0aGlzLmZpcnN0ID0gQnVmZmVyLmNvbmNhdChbdGhpcy5maXJzdCwgYnl0ZXMuc3ViYXJyYXkoMCwgdGFrZSldKTtcbiAgICAgIGJ5dGVzID0gYnl0ZXMuc3ViYXJyYXkodGFrZSk7XG4gICAgfVxuICAgIGNvbnN0IGtlZXAgPSB0aGlzLmxpbWl0IC0gaGVhZDtcbiAgICB0aGlzLmxhc3QgPSBCdWZmZXIuY29uY2F0KFt0aGlzLmxhc3QsIGJ5dGVzLnN1YmFycmF5KE1hdGgubWF4KDAsIGJ5dGVzLmxlbmd0aCAtIGtlZXApKV0pLnN1YmFycmF5KC1rZWVwKTtcbiAgfVxuICB0ZXh0KCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHJlZGFjdCh0aGlzLnJhd1RleHQoKSk7XG4gIH1cbiAgLyoqIE9ubHkgc3RydWN0dXJlZCBkZWNvZGVycyBtYXkgdXNlIHJhdyBjYXB0dXJlOyBkaXNwbGF5IHBhdGhzIG11c3QgY2FsbCB0ZXh0KCkuICovXG4gIHJhd1RleHQoKTogc3RyaW5nIHtcbiAgICBjb25zdCBvbWl0dGVkID0gTWF0aC5tYXgoMCwgdGhpcy50b3RhbCAtIHRoaXMuZmlyc3QubGVuZ3RoIC0gdGhpcy5sYXN0Lmxlbmd0aCk7XG4gICAgaWYgKCFvbWl0dGVkKSByZXR1cm4gQnVmZmVyLmNvbmNhdChbdGhpcy5maXJzdCwgdGhpcy5sYXN0XSkudG9TdHJpbmcoXCJ1dGY4XCIpO1xuICAgIGxldCBoZWFkID0gdGhpcy5maXJzdC5sZW5ndGgsXG4gICAgICB0YWlsID0gMDtcbiAgICBpZiAoaGVhZCkge1xuICAgICAgbGV0IGxlYWQgPSBoZWFkIC0gMTtcbiAgICAgIHdoaWxlIChsZWFkID4gMCAmJiAoKHRoaXMuZmlyc3RbbGVhZF0gPz8gMCkgJiAweGMwKSA9PT0gMHg4MCkgbGVhZC0tO1xuICAgICAgY29uc3QgYnl0ZSA9IHRoaXMuZmlyc3RbbGVhZF0gPz8gMDtcbiAgICAgIGNvbnN0IHdpZHRoID0gYnl0ZSA8IDB4ODAgPyAxIDogYnl0ZSA8IDB4ZTAgPyAyIDogYnl0ZSA8IDB4ZjAgPyAzIDogNDtcbiAgICAgIGlmIChoZWFkIC0gbGVhZCA8IHdpZHRoKSBoZWFkID0gbGVhZDtcbiAgICB9XG4gICAgd2hpbGUgKHRhaWwgPCB0aGlzLmxhc3QubGVuZ3RoICYmICgodGhpcy5sYXN0W3RhaWxdID8/IDApICYgMHhjMCkgPT09IDB4ODApIHRhaWwrKztcbiAgICBjb25zdCBza2lwcGVkID0gdGhpcy50b3RhbCAtIGhlYWQgLSAodGhpcy5sYXN0Lmxlbmd0aCAtIHRhaWwpO1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmZpcnN0LnN1YmFycmF5KDAsIGhlYWQpLnRvU3RyaW5nKFwidXRmOFwiKSArXG4gICAgICBgXFxuWyR7U3RyaW5nKHNraXBwZWQpfSBkaWFnbm9zdGljIGJ5dGVzIG9taXR0ZWRdXFxuYCArXG4gICAgICB0aGlzLmxhc3Quc3ViYXJyYXkodGFpbCkudG9TdHJpbmcoXCJ1dGY4XCIpXG4gICAgKTtcbiAgfVxuICBnZXQgYnl0ZXMoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy50b3RhbDtcbiAgfVxufVxuXG4vKiogUmVkYWN0IHNlY3JldHMgYWNyb3NzIHN0cmVhbSBjaHVuayBib3VuZGFyaWVzIHdpdGhvdXQgYnVmZmVyaW5nIGFuIGVudGlyZSBsb2cuICovXG5leHBvcnQgY2xhc3MgRGlhZ25vc3RpY1JlZGFjdG9yIGV4dGVuZHMgVHJhbnNmb3JtIHtcbiAgcHJpdmF0ZSByZWFkb25seSBkZWNvZGVyID0gbmV3IFN0cmluZ0RlY29kZXIoXCJ1dGY4XCIpO1xuICBwcml2YXRlIHBlbmRpbmcgPSBcIlwiO1xuICBwcml2YXRlIHJlYWRvbmx5IG92ZXJsYXA6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBtdWx0aWxpbmU6IGJvb2xlYW47XG4gIHByaXZhdGUgY29udGludWF0aW9uOiBcInVybFwiIHwgXCJjcmVkZW50aWFsXCIgfCAnXCInIHwgXCInXCIgfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgZXNjYXBlZCA9IGZhbHNlO1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IHNlY3JldHMgPSBzZWNyZXRWYWx1ZXMoKSkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5vdmVybGFwID0gTWF0aC5tYXgoNDA5NiwgLi4uc2VjcmV0cy5tYXAoKHNlY3JldCkgPT4gc2VjcmV0Lmxlbmd0aCkpO1xuICAgIHRoaXMubXVsdGlsaW5lID0gc2VjcmV0cy5zb21lKChzZWNyZXQpID0+IHNlY3JldC5pbmNsdWRlcyhcIlxcblwiKSk7XG4gIH1cbiAgb3ZlcnJpZGUgX3RyYW5zZm9ybShieXRlczogQnVmZmVyLCBfZW5jb2Rpbmc6IEJ1ZmZlckVuY29kaW5nLCBjYWxsYmFjazogVHJhbnNmb3JtQ2FsbGJhY2spOiB2b2lkIHtcbiAgICB0aGlzLnBlbmRpbmcgKz0gdGhpcy5kZWNvZGVyLndyaXRlKGJ5dGVzKTtcbiAgICBpZiAodGhpcy5jb250aW51YXRpb24pIHtcbiAgICAgIGxldCBib3VuZGFyeSA9IC0xO1xuICAgICAgaWYgKHRoaXMuY29udGludWF0aW9uID09PSAnXCInIHx8IHRoaXMuY29udGludWF0aW9uID09PSBcIidcIikge1xuICAgICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgdGhpcy5wZW5kaW5nLmxlbmd0aDsgaW5kZXgrKykge1xuICAgICAgICAgIGNvbnN0IGNoYXJhY3RlciA9IHRoaXMucGVuZGluZ1tpbmRleF07XG4gICAgICAgICAgaWYgKHRoaXMuZXNjYXBlZCkgdGhpcy5lc2NhcGVkID0gZmFsc2U7XG4gICAgICAgICAgZWxzZSBpZiAoY2hhcmFjdGVyID09PSBcIlxcXFxcIikgdGhpcy5lc2NhcGVkID0gdHJ1ZTtcbiAgICAgICAgICBlbHNlIGlmIChjaGFyYWN0ZXIgPT09IHRoaXMuY29udGludWF0aW9uKSB7XG4gICAgICAgICAgICBib3VuZGFyeSA9IGluZGV4ICsgMTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYm91bmRhcnkgPSAodGhpcy5jb250aW51YXRpb24gPT09IFwidXJsXCIgPyAvW1xcczw+XCInXS8gOiAvW1xccyw7XS8pLmV4ZWModGhpcy5wZW5kaW5nKT8uaW5kZXggPz8gLTE7XG4gICAgICB9XG4gICAgICBpZiAoYm91bmRhcnkgPCAwKSB7XG4gICAgICAgIHRoaXMucGVuZGluZyA9IFwiXCI7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMucGVuZGluZyA9IHRoaXMucGVuZGluZy5zbGljZShib3VuZGFyeSk7XG4gICAgICB0aGlzLmNvbnRpbnVhdGlvbiA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuZXNjYXBlZCA9IGZhbHNlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHNlY3JldCBvZiB0aGlzLnNlY3JldHMpIHRoaXMucGVuZGluZyA9IHRoaXMucGVuZGluZy5zcGxpdChzZWNyZXQpLmpvaW4oXCJbUkVEQUNURURdXCIpO1xuICAgIGNvbnN0IHVybCA9IC9odHRwcz86XFwvXFwvW15cXHM8PlwiJ10qJC8uZXhlYyh0aGlzLnBlbmRpbmcpO1xuICAgIGNvbnN0IGNyZWRlbnRpYWwgPSBuZXcgUmVnRXhwKFxuICAgICAgU3RyaW5nLnJhd2BcXGIke2NyZWRlbnRpYWxOYW1lc31bXCInXT9cXHMqWzo9XVxccyooPzpcIig/OlxcXFxbXFxzXFxTXXxbXlwiXFxcXF0pKlxcXFw/fCcoPzpcXFxcW1xcc1xcU118W14nXFxcXF0pKlxcXFw/fCg/OkJlYXJlclxccyspP1teXFxzLDtcIiddKikkYCxcbiAgICAgIFwiaVwiLFxuICAgICkuZXhlYyh0aGlzLnBlbmRpbmcpO1xuICAgIGNvbnN0IHRva2VuID0gdXJsICYmICghY3JlZGVudGlhbCB8fCB1cmwuaW5kZXggPCBjcmVkZW50aWFsLmluZGV4KSA/IHVybCA6IGNyZWRlbnRpYWw7XG4gICAgaWYgKHRva2VuICYmIHRva2VuWzBdLmxlbmd0aCA+IHRoaXMub3ZlcmxhcCkge1xuICAgICAgdGhpcy5wdXNoKFxuICAgICAgICByZWRhY3QodGhpcy5wZW5kaW5nLnNsaWNlKDAsIHRva2VuLmluZGV4KSwgdGhpcy5zZWNyZXRzKSArIFwiW1JFREFDVEVEOiBvdmVyc2l6ZWQgdG9rZW4gY29udGludWF0aW9uIG9taXR0ZWRdXCIsXG4gICAgICApO1xuICAgICAgY29uc3QgcXVvdGUgPSB0b2tlbiA9PT0gY3JlZGVudGlhbCA/IC9bOj1dXFxzKihbXCInXSkvLmV4ZWModG9rZW5bMF0pPy5bMV0gOiB1bmRlZmluZWQ7XG4gICAgICB0aGlzLmNvbnRpbnVhdGlvbiA9IHF1b3RlID09PSAnXCInIHx8IHF1b3RlID09PSBcIidcIiA/IHF1b3RlIDogdG9rZW4gPT09IHVybCA/IFwidXJsXCIgOiBcImNyZWRlbnRpYWxcIjtcbiAgICAgIHRoaXMuZXNjYXBlZCA9ICgvXFxcXCskLy5leGVjKHRva2VuWzBdKT8uWzBdLmxlbmd0aCA/PyAwKSAlIDIgPT09IDE7XG4gICAgICB0aGlzLnBlbmRpbmcgPSBcIlwiO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBSZWRhY3QgY29tcGxldGUgdG9rZW5zIGJlZm9yZSBjaG9vc2luZyBhIGNodW5rIGJvdW5kYXJ5LCB3aGlsZSByZXRhaW5pbmcgaW5jb21wbGV0ZSB0YWlscyB2ZXJiYXRpbS5cbiAgICAgIGNvbnN0IHByZWZpeCA9IHJlZGFjdCh0b2tlbiA/IHRoaXMucGVuZGluZy5zbGljZSgwLCB0b2tlbi5pbmRleCkgOiB0aGlzLnBlbmRpbmcsIHRoaXMuc2VjcmV0cyk7XG4gICAgICB0aGlzLnBlbmRpbmcgPSBwcmVmaXggKyAodG9rZW4/LlswXSA/PyBcIlwiKTtcbiAgICAgIGNvbnN0IG5ld2xpbmUgPSBwcmVmaXgubGFzdEluZGV4T2YoXCJcXG5cIik7XG4gICAgICBjb25zdCBlbmQgPSBNYXRoLm1pbihcbiAgICAgICAgcHJlZml4Lmxlbmd0aCxcbiAgICAgICAgbmV3bGluZSA+PSAwICYmICF0aGlzLm11bHRpbGluZSA/IG5ld2xpbmUgKyAxIDogTWF0aC5tYXgoMCwgdGhpcy5wZW5kaW5nLmxlbmd0aCAtIHRoaXMub3ZlcmxhcCksXG4gICAgICApO1xuICAgICAgdGhpcy5wdXNoKHRoaXMucGVuZGluZy5zbGljZSgwLCBlbmQpKTtcbiAgICAgIHRoaXMucGVuZGluZyA9IHRoaXMucGVuZGluZy5zbGljZShlbmQpO1xuICAgIH1cbiAgICBjYWxsYmFjaygpO1xuICB9XG4gIG92ZXJyaWRlIF9mbHVzaChjYWxsYmFjazogVHJhbnNmb3JtQ2FsbGJhY2spOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGludWF0aW9uKSB0aGlzLnB1c2gocmVkYWN0KHRoaXMucGVuZGluZyArIHRoaXMuZGVjb2Rlci5lbmQoKSwgdGhpcy5zZWNyZXRzKSk7XG4gICAgY2FsbGJhY2soKTtcbiAgfVxufVxuXG4vKiogRHJhaW4gcmVkYWN0ZWQgYnl0ZXMgYmVmb3JlIGNsb3NpbmcgYSByZXRhaW5lZCBsb2c7IGEgZmFpbGVkIHNpbmsgbXVzdCBub3Qgc3RhbGwgdGhlIGNoaWxkIHByb2Nlc3MuICovXG5leHBvcnQgZnVuY3Rpb24gcmV0YWluRGlhZ25vc3RpY1N0cmVhbShzb3VyY2U6IFJlYWRhYmxlLCBkZXN0aW5hdGlvbjogV3JpdGFibGUsIHNlY3JldHM/OiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZWRhY3RvciA9IG5ldyBEaWFnbm9zdGljUmVkYWN0b3Ioc2VjcmV0cyk7XG4gIGNvbnN0IGZhaWwgPSAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgc291cmNlLnVucGlwZShyZWRhY3Rvcik7XG4gICAgcmVkYWN0b3IudW5waXBlKGRlc3RpbmF0aW9uKTtcbiAgICByZWRhY3Rvci5kZXN0cm95KGVycm9yKTtcbiAgICBzb3VyY2UucmVzdW1lKCk7XG4gIH07XG4gIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgIGlmICghc291cmNlLnJlYWRhYmxlRW5kZWQpIGZhaWwobmV3IEVycm9yKFwiRGlhZ25vc3RpYyBzb3VyY2UgY2xvc2VkIGJlZm9yZSBpdHMgb3V0cHV0IHdhcyBkcmFpbmVkXCIpKTtcbiAgfTtcbiAgc291cmNlLm9uKFwiZXJyb3JcIiwgZmFpbCk7XG4gIHNvdXJjZS5vbihcImNsb3NlXCIsIGNsb3NlKTtcbiAgZGVzdGluYXRpb24ub24oXCJlcnJvclwiLCBmYWlsKTtcbiAgY29uc3QgY29tcGxldGlvbiA9IGZpbmlzaGVkKHJlZGFjdG9yLCB7IGNsZWFudXA6IHRydWUgfSkuZmluYWxseSgoKSA9PiB7XG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgZmFpbCk7XG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKFwiY2xvc2VcIiwgY2xvc2UpO1xuICAgIGRlc3RpbmF0aW9uLnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgZmFpbCk7XG4gIH0pO1xuICBzb3VyY2UucGlwZShyZWRhY3RvcikucGlwZShkZXN0aW5hdGlvbiwgeyBlbmQ6IGZhbHNlIH0pO1xuICByZXR1cm4gY29tcGxldGlvbjtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsaUJBQXVFO0FBQ2hGLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsZ0NBQWdDO0FBRWxDLE1BQU0sa0JBQ1g7QUFDSyxNQUFNLFdBQVcsQ0FBQyxTQUN2Qix5QkFBeUIsSUFBSSxFQUFFLFFBQVEsWUFBWSxDQUFDLE1BQU8sTUFBTSxRQUFRLE1BQU0sTUFBTyxJQUFJLEVBQUc7QUFHL0YsSUFBSSxlQUFlLENBQUMsU0FBaUIsT0FBTyxXQUFXLElBQUk7QUFDM0Qs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
