// Generated from diagnostic-text.mts; edit the TypeScript source.
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";
const credentialNames = "(?:authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|private[_-]?key|secret)";
const safeText = (text) => stripVTControlCharacters(text).replace(/\p{Cc}/gu, (c) => c === "\n" || c === "	" ? c : "");
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
  redact,
  retainDiagnosticStream,
  safeText,
  secretValues
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRpYWdub3N0aWMtdGV4dC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RyaW5nRGVjb2RlciB9IGZyb20gXCJub2RlOnN0cmluZ19kZWNvZGVyXCI7XG5pbXBvcnQgeyBUcmFuc2Zvcm0sIHR5cGUgVHJhbnNmb3JtQ2FsbGJhY2ssIHR5cGUgUmVhZGFibGUsIHR5cGUgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IGZpbmlzaGVkIH0gZnJvbSBcIm5vZGU6c3RyZWFtL3Byb21pc2VzXCI7XG5pbXBvcnQgeyBzdHJpcFZUQ29udHJvbENoYXJhY3RlcnMgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5cbmV4cG9ydCBjb25zdCBjcmVkZW50aWFsTmFtZXMgPVxuICBcIig/OmF1dGhvcml6YXRpb258cGFzc3dvcmR8YXBpW18tXT9rZXl8YWNjZXNzW18tXT90b2tlbnxyZWZyZXNoW18tXT90b2tlbnxpZFtfLV0/dG9rZW58dG9rZW58Y2xpZW50W18tXT9zZWNyZXR8cHJpdmF0ZVtfLV0/a2V5fHNlY3JldClcIjtcbmV4cG9ydCBjb25zdCBzYWZlVGV4dCA9ICh0ZXh0OiBzdHJpbmcpID0+XG4gIHN0cmlwVlRDb250cm9sQ2hhcmFjdGVycyh0ZXh0KS5yZXBsYWNlKC9cXHB7Q2N9L2d1LCAoYykgPT4gKGMgPT09IFwiXFxuXCIgfHwgYyA9PT0gXCJcXHRcIiA/IGMgOiBcIlwiKSk7XG5leHBvcnQgZnVuY3Rpb24gc2VjcmV0VmFsdWVzKGVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSBwcm9jZXNzLmVudik6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKGVudikuZmxhdE1hcCgoW2tleSwgdmFsdWVdKSA9PlxuICAgIC8oPzpUT0tFTnxQQVNTV09SRHxTRUNSRVR8QVBJX0tFWXxBVVRIT1JJWkFUSU9OfENSRURFTlRJQUwpL2kudGVzdChrZXkpICYmXG4gICAgdmFsdWUgJiZcbiAgICB2YWx1ZS5sZW5ndGggPj0gNiAmJlxuICAgIHZhbHVlLmxlbmd0aCA8PSAxNjM4NFxuICAgICAgPyBbdmFsdWVdXG4gICAgICA6IFtdLFxuICApO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdCh0ZXh0OiBzdHJpbmcsIHNlY3JldHMgPSBzZWNyZXRWYWx1ZXMoKSk6IHN0cmluZyB7XG4gIGxldCByZXN1bHQgPSB0ZXh0O1xuICBmb3IgKGNvbnN0IHNlY3JldCBvZiBbLi4uc2VjcmV0c10uc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCkpXG4gICAgcmVzdWx0ID0gcmVzdWx0LnNwbGl0KHNlY3JldCkuam9pbihcIltSRURBQ1RFRF1cIik7XG4gIHJldHVybiByZXN1bHRcbiAgICAucmVwbGFjZSgvaHR0cHM/OlxcL1xcL1teXFxzPD5cIiddKy9nLCAodGV4dCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTCh0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWU7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFwiW2ludmFsaWQgVVJMXVwiO1xuICAgICAgfVxuICAgIH0pXG4gICAgLnJlcGxhY2UoXG4gICAgICBuZXcgUmVnRXhwKFxuICAgICAgICBTdHJpbmcucmF3YFxcYigke2NyZWRlbnRpYWxOYW1lc31bXCInXT9cXHMqWzo9XVxccyopKFwiKD86XFxcXC58W15cIlxcXFxdKSpcInwnKD86XFxcXC58W14nXFxcXF0pKid8KD86QmVhcmVyXFxzKyk/W15cXHMsO10rKWAsXG4gICAgICAgIFwiZ2lcIixcbiAgICAgICksXG4gICAgICAoX2FsbCwgcHJlZml4OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpID0+XG4gICAgICAgIHByZWZpeCArICh2YWx1ZS5zdGFydHNXaXRoKCdcIicpID8gJ1wiW1JFREFDVEVEXVwiJyA6IHZhbHVlLnN0YXJ0c1dpdGgoXCInXCIpID8gXCInW1JFREFDVEVEXSdcIiA6IFwiW1JFREFDVEVEXVwiKSxcbiAgICApO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGNsaXBwZWQodGV4dDogc3RyaW5nLCBtYXhpbXVtID0gNDA5Niwgc2VjcmV0cyA9IHNlY3JldFZhbHVlcygpKTogeyB0ZXh0OiBzdHJpbmc7IG9taXR0ZWQ6IG51bWJlciB9IHtcbiAgcmV0dXJuIGJvdW5kZWRUZXh0KHNhZmVUZXh0KHJlZGFjdCh0ZXh0LCBzZWNyZXRzKSksIG1heGltdW0pO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGJvdW5kZWRUZXh0KHRleHQ6IHN0cmluZywgbWF4aW11bSA9IDQwOTYpOiB7IHRleHQ6IHN0cmluZzsgb21pdHRlZDogbnVtYmVyIH0ge1xuICBjb25zdCBieXRlcyA9IEJ1ZmZlci5mcm9tKHRleHQpO1xuICBpZiAoYnl0ZXMubGVuZ3RoIDw9IG1heGltdW0pIHJldHVybiB7IHRleHQ6IGJ5dGVzLnRvU3RyaW5nKCksIG9taXR0ZWQ6IDAgfTtcbiAgY29uc3QgYnVkZ2V0ID0gTWF0aC5tYXgoMCwgbWF4aW11bSAtIDY0KTtcbiAgbGV0IGhlYWQgPSBNYXRoLmZsb29yKGJ1ZGdldCAvIDIpLFxuICAgIHRhaWwgPSBieXRlcy5sZW5ndGggLSAoYnVkZ2V0IC0gaGVhZCk7XG4gIHdoaWxlIChoZWFkID4gMCAmJiAoKGJ5dGVzW2hlYWRdID8/IDApICYgMHhjMCkgPT09IDB4ODApIGhlYWQtLTtcbiAgd2hpbGUgKHRhaWwgPCBieXRlcy5sZW5ndGggJiYgKChieXRlc1t0YWlsXSA/PyAwKSAmIDB4YzApID09PSAweDgwKSB0YWlsKys7XG4gIGNvbnN0IG9taXR0ZWQgPSB0YWlsIC0gaGVhZDtcbiAgcmV0dXJuIHtcbiAgICB0ZXh0OiBgJHtieXRlcy5zdWJhcnJheSgwLCBoZWFkKS50b1N0cmluZygpfVske1N0cmluZyhvbWl0dGVkKX0gZGlhZ25vc3RpYyBieXRlcyBvbWl0dGVkXSR7Ynl0ZXMuc3ViYXJyYXkodGFpbCkudG9TdHJpbmcoKX1gLFxuICAgIG9taXR0ZWQsXG4gIH07XG59XG4vKiogQm91bmRlZCBVVEYtOCBoZWFkL3RhaWwgY2FwdHVyZSBjb3VudHMgZXZlcnkgb21pdHRlZCBieXRlLCBpbmNsdWRpbmcgb3ZlcnNpemVkIGZpcnN0IGNodW5rcy4gKi9cbmV4cG9ydCBjbGFzcyBEaWFnbm9zdGljQ2FwdHVyZSB7XG4gIHByaXZhdGUgZmlyc3QgPSBCdWZmZXIuYWxsb2MoMCk7XG4gIHByaXZhdGUgbGFzdCA9IEJ1ZmZlci5hbGxvYygwKTtcbiAgcHJpdmF0ZSB0b3RhbCA9IDA7XG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgbGltaXQgPSA2NTUzNikge1xuICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIobGltaXQpIHx8IGxpbWl0IDwgMiB8fCBsaW1pdCA+IDEwNDg1NzYpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJkaWFnbm9zdGljIGNhcHR1cmUgbGltaXQgbXVzdCBiZSBiZXR3ZWVuIDIgYW5kIDEwNDg1NzYgYnl0ZXNcIik7XG4gIH1cbiAgYWRkKGJ5dGVzOiBCdWZmZXIpOiB2b2lkIHtcbiAgICB0aGlzLnRvdGFsICs9IGJ5dGVzLmxlbmd0aDtcbiAgICBjb25zdCBoZWFkID0gTWF0aC5mbG9vcih0aGlzLmxpbWl0IC8gMik7XG4gICAgaWYgKHRoaXMuZmlyc3QubGVuZ3RoIDwgaGVhZCkge1xuICAgICAgY29uc3QgdGFrZSA9IE1hdGgubWluKGhlYWQgLSB0aGlzLmZpcnN0Lmxlbmd0aCwgYnl0ZXMubGVuZ3RoKTtcbiAgICAgIHRoaXMuZmlyc3QgPSBCdWZmZXIuY29uY2F0KFt0aGlzLmZpcnN0LCBieXRlcy5zdWJhcnJheSgwLCB0YWtlKV0pO1xuICAgICAgYnl0ZXMgPSBieXRlcy5zdWJhcnJheSh0YWtlKTtcbiAgICB9XG4gICAgY29uc3Qga2VlcCA9IHRoaXMubGltaXQgLSBoZWFkO1xuICAgIHRoaXMubGFzdCA9IEJ1ZmZlci5jb25jYXQoW3RoaXMubGFzdCwgYnl0ZXMuc3ViYXJyYXkoTWF0aC5tYXgoMCwgYnl0ZXMubGVuZ3RoIC0ga2VlcCkpXSkuc3ViYXJyYXkoLWtlZXApO1xuICB9XG4gIHRleHQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gcmVkYWN0KHRoaXMucmF3VGV4dCgpKTtcbiAgfVxuICAvKiogT25seSBzdHJ1Y3R1cmVkIGRlY29kZXJzIG1heSB1c2UgcmF3IGNhcHR1cmU7IGRpc3BsYXkgcGF0aHMgbXVzdCBjYWxsIHRleHQoKS4gKi9cbiAgcmF3VGV4dCgpOiBzdHJpbmcge1xuICAgIGNvbnN0IG9taXR0ZWQgPSBNYXRoLm1heCgwLCB0aGlzLnRvdGFsIC0gdGhpcy5maXJzdC5sZW5ndGggLSB0aGlzLmxhc3QubGVuZ3RoKTtcbiAgICBpZiAoIW9taXR0ZWQpIHJldHVybiBCdWZmZXIuY29uY2F0KFt0aGlzLmZpcnN0LCB0aGlzLmxhc3RdKS50b1N0cmluZyhcInV0ZjhcIik7XG4gICAgbGV0IGhlYWQgPSB0aGlzLmZpcnN0Lmxlbmd0aCxcbiAgICAgIHRhaWwgPSAwO1xuICAgIGlmIChoZWFkKSB7XG4gICAgICBsZXQgbGVhZCA9IGhlYWQgLSAxO1xuICAgICAgd2hpbGUgKGxlYWQgPiAwICYmICgodGhpcy5maXJzdFtsZWFkXSA/PyAwKSAmIDB4YzApID09PSAweDgwKSBsZWFkLS07XG4gICAgICBjb25zdCBieXRlID0gdGhpcy5maXJzdFtsZWFkXSA/PyAwO1xuICAgICAgY29uc3Qgd2lkdGggPSBieXRlIDwgMHg4MCA/IDEgOiBieXRlIDwgMHhlMCA/IDIgOiBieXRlIDwgMHhmMCA/IDMgOiA0O1xuICAgICAgaWYgKGhlYWQgLSBsZWFkIDwgd2lkdGgpIGhlYWQgPSBsZWFkO1xuICAgIH1cbiAgICB3aGlsZSAodGFpbCA8IHRoaXMubGFzdC5sZW5ndGggJiYgKCh0aGlzLmxhc3RbdGFpbF0gPz8gMCkgJiAweGMwKSA9PT0gMHg4MCkgdGFpbCsrO1xuICAgIGNvbnN0IHNraXBwZWQgPSB0aGlzLnRvdGFsIC0gaGVhZCAtICh0aGlzLmxhc3QubGVuZ3RoIC0gdGFpbCk7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuZmlyc3Quc3ViYXJyYXkoMCwgaGVhZCkudG9TdHJpbmcoXCJ1dGY4XCIpICtcbiAgICAgIGBcXG5bJHtTdHJpbmcoc2tpcHBlZCl9IGRpYWdub3N0aWMgYnl0ZXMgb21pdHRlZF1cXG5gICtcbiAgICAgIHRoaXMubGFzdC5zdWJhcnJheSh0YWlsKS50b1N0cmluZyhcInV0ZjhcIilcbiAgICApO1xuICB9XG4gIGdldCBieXRlcygpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnRvdGFsO1xuICB9XG59XG5cbi8qKiBSZWRhY3Qgc2VjcmV0cyBhY3Jvc3Mgc3RyZWFtIGNodW5rIGJvdW5kYXJpZXMgd2l0aG91dCBidWZmZXJpbmcgYW4gZW50aXJlIGxvZy4gKi9cbmV4cG9ydCBjbGFzcyBEaWFnbm9zdGljUmVkYWN0b3IgZXh0ZW5kcyBUcmFuc2Zvcm0ge1xuICBwcml2YXRlIHJlYWRvbmx5IGRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihcInV0ZjhcIik7XG4gIHByaXZhdGUgcGVuZGluZyA9IFwiXCI7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3ZlcmxhcDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG11bHRpbGluZTogYm9vbGVhbjtcbiAgcHJpdmF0ZSBjb250aW51YXRpb246IFwidXJsXCIgfCBcImNyZWRlbnRpYWxcIiB8ICdcIicgfCBcIidcIiB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBlc2NhcGVkID0gZmFsc2U7XG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgc2VjcmV0cyA9IHNlY3JldFZhbHVlcygpKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLm92ZXJsYXAgPSBNYXRoLm1heCg0MDk2LCAuLi5zZWNyZXRzLm1hcCgoc2VjcmV0KSA9PiBzZWNyZXQubGVuZ3RoKSk7XG4gICAgdGhpcy5tdWx0aWxpbmUgPSBzZWNyZXRzLnNvbWUoKHNlY3JldCkgPT4gc2VjcmV0LmluY2x1ZGVzKFwiXFxuXCIpKTtcbiAgfVxuICBvdmVycmlkZSBfdHJhbnNmb3JtKGJ5dGVzOiBCdWZmZXIsIF9lbmNvZGluZzogQnVmZmVyRW5jb2RpbmcsIGNhbGxiYWNrOiBUcmFuc2Zvcm1DYWxsYmFjayk6IHZvaWQge1xuICAgIHRoaXMucGVuZGluZyArPSB0aGlzLmRlY29kZXIud3JpdGUoYnl0ZXMpO1xuICAgIGlmICh0aGlzLmNvbnRpbnVhdGlvbikge1xuICAgICAgbGV0IGJvdW5kYXJ5ID0gLTE7XG4gICAgICBpZiAodGhpcy5jb250aW51YXRpb24gPT09ICdcIicgfHwgdGhpcy5jb250aW51YXRpb24gPT09IFwiJ1wiKSB7XG4gICAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCB0aGlzLnBlbmRpbmcubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgICAgICAgY29uc3QgY2hhcmFjdGVyID0gdGhpcy5wZW5kaW5nW2luZGV4XTtcbiAgICAgICAgICBpZiAodGhpcy5lc2NhcGVkKSB0aGlzLmVzY2FwZWQgPSBmYWxzZTtcbiAgICAgICAgICBlbHNlIGlmIChjaGFyYWN0ZXIgPT09IFwiXFxcXFwiKSB0aGlzLmVzY2FwZWQgPSB0cnVlO1xuICAgICAgICAgIGVsc2UgaWYgKGNoYXJhY3RlciA9PT0gdGhpcy5jb250aW51YXRpb24pIHtcbiAgICAgICAgICAgIGJvdW5kYXJ5ID0gaW5kZXggKyAxO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBib3VuZGFyeSA9ICh0aGlzLmNvbnRpbnVhdGlvbiA9PT0gXCJ1cmxcIiA/IC9bXFxzPD5cIiddLyA6IC9bXFxzLDtdLykuZXhlYyh0aGlzLnBlbmRpbmcpPy5pbmRleCA/PyAtMTtcbiAgICAgIH1cbiAgICAgIGlmIChib3VuZGFyeSA8IDApIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nID0gXCJcIjtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5wZW5kaW5nID0gdGhpcy5wZW5kaW5nLnNsaWNlKGJvdW5kYXJ5KTtcbiAgICAgIHRoaXMuY29udGludWF0aW9uID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5lc2NhcGVkID0gZmFsc2U7XG4gICAgfVxuICAgIGZvciAoY29uc3Qgc2VjcmV0IG9mIHRoaXMuc2VjcmV0cykgdGhpcy5wZW5kaW5nID0gdGhpcy5wZW5kaW5nLnNwbGl0KHNlY3JldCkuam9pbihcIltSRURBQ1RFRF1cIik7XG4gICAgY29uc3QgdXJsID0gL2h0dHBzPzpcXC9cXC9bXlxcczw+XCInXSokLy5leGVjKHRoaXMucGVuZGluZyk7XG4gICAgY29uc3QgY3JlZGVudGlhbCA9IG5ldyBSZWdFeHAoXG4gICAgICBTdHJpbmcucmF3YFxcYiR7Y3JlZGVudGlhbE5hbWVzfVtcIiddP1xccypbOj1dXFxzKig/OlwiKD86XFxcXFtcXHNcXFNdfFteXCJcXFxcXSkqXFxcXD98Jyg/OlxcXFxbXFxzXFxTXXxbXidcXFxcXSkqXFxcXD98KD86QmVhcmVyXFxzKyk/W15cXHMsO1wiJ10qKSRgLFxuICAgICAgXCJpXCIsXG4gICAgKS5leGVjKHRoaXMucGVuZGluZyk7XG4gICAgY29uc3QgdG9rZW4gPSB1cmwgJiYgKCFjcmVkZW50aWFsIHx8IHVybC5pbmRleCA8IGNyZWRlbnRpYWwuaW5kZXgpID8gdXJsIDogY3JlZGVudGlhbDtcbiAgICBpZiAodG9rZW4gJiYgdG9rZW5bMF0ubGVuZ3RoID4gdGhpcy5vdmVybGFwKSB7XG4gICAgICB0aGlzLnB1c2goXG4gICAgICAgIHJlZGFjdCh0aGlzLnBlbmRpbmcuc2xpY2UoMCwgdG9rZW4uaW5kZXgpLCB0aGlzLnNlY3JldHMpICsgXCJbUkVEQUNURUQ6IG92ZXJzaXplZCB0b2tlbiBjb250aW51YXRpb24gb21pdHRlZF1cIixcbiAgICAgICk7XG4gICAgICBjb25zdCBxdW90ZSA9IHRva2VuID09PSBjcmVkZW50aWFsID8gL1s6PV1cXHMqKFtcIiddKS8uZXhlYyh0b2tlblswXSk/LlsxXSA6IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuY29udGludWF0aW9uID0gcXVvdGUgPT09ICdcIicgfHwgcXVvdGUgPT09IFwiJ1wiID8gcXVvdGUgOiB0b2tlbiA9PT0gdXJsID8gXCJ1cmxcIiA6IFwiY3JlZGVudGlhbFwiO1xuICAgICAgdGhpcy5lc2NhcGVkID0gKC9cXFxcKyQvLmV4ZWModG9rZW5bMF0pPy5bMF0ubGVuZ3RoID8/IDApICUgMiA9PT0gMTtcbiAgICAgIHRoaXMucGVuZGluZyA9IFwiXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFJlZGFjdCBjb21wbGV0ZSB0b2tlbnMgYmVmb3JlIGNob29zaW5nIGEgY2h1bmsgYm91bmRhcnksIHdoaWxlIHJldGFpbmluZyBpbmNvbXBsZXRlIHRhaWxzIHZlcmJhdGltLlxuICAgICAgY29uc3QgcHJlZml4ID0gcmVkYWN0KHRva2VuID8gdGhpcy5wZW5kaW5nLnNsaWNlKDAsIHRva2VuLmluZGV4KSA6IHRoaXMucGVuZGluZywgdGhpcy5zZWNyZXRzKTtcbiAgICAgIHRoaXMucGVuZGluZyA9IHByZWZpeCArICh0b2tlbj8uWzBdID8/IFwiXCIpO1xuICAgICAgY29uc3QgbmV3bGluZSA9IHByZWZpeC5sYXN0SW5kZXhPZihcIlxcblwiKTtcbiAgICAgIGNvbnN0IGVuZCA9IE1hdGgubWluKFxuICAgICAgICBwcmVmaXgubGVuZ3RoLFxuICAgICAgICBuZXdsaW5lID49IDAgJiYgIXRoaXMubXVsdGlsaW5lID8gbmV3bGluZSArIDEgOiBNYXRoLm1heCgwLCB0aGlzLnBlbmRpbmcubGVuZ3RoIC0gdGhpcy5vdmVybGFwKSxcbiAgICAgICk7XG4gICAgICB0aGlzLnB1c2godGhpcy5wZW5kaW5nLnNsaWNlKDAsIGVuZCkpO1xuICAgICAgdGhpcy5wZW5kaW5nID0gdGhpcy5wZW5kaW5nLnNsaWNlKGVuZCk7XG4gICAgfVxuICAgIGNhbGxiYWNrKCk7XG4gIH1cbiAgb3ZlcnJpZGUgX2ZsdXNoKGNhbGxiYWNrOiBUcmFuc2Zvcm1DYWxsYmFjayk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb250aW51YXRpb24pIHRoaXMucHVzaChyZWRhY3QodGhpcy5wZW5kaW5nICsgdGhpcy5kZWNvZGVyLmVuZCgpLCB0aGlzLnNlY3JldHMpKTtcbiAgICBjYWxsYmFjaygpO1xuICB9XG59XG5cbi8qKiBEcmFpbiByZWRhY3RlZCBieXRlcyBiZWZvcmUgY2xvc2luZyBhIHJldGFpbmVkIGxvZzsgYSBmYWlsZWQgc2luayBtdXN0IG5vdCBzdGFsbCB0aGUgY2hpbGQgcHJvY2Vzcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXRhaW5EaWFnbm9zdGljU3RyZWFtKHNvdXJjZTogUmVhZGFibGUsIGRlc3RpbmF0aW9uOiBXcml0YWJsZSwgc2VjcmV0cz86IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlZGFjdG9yID0gbmV3IERpYWdub3N0aWNSZWRhY3RvcihzZWNyZXRzKTtcbiAgY29uc3QgZmFpbCA9IChlcnJvcjogRXJyb3IpID0+IHtcbiAgICBzb3VyY2UudW5waXBlKHJlZGFjdG9yKTtcbiAgICByZWRhY3Rvci51bnBpcGUoZGVzdGluYXRpb24pO1xuICAgIHJlZGFjdG9yLmRlc3Ryb3koZXJyb3IpO1xuICAgIHNvdXJjZS5yZXN1bWUoKTtcbiAgfTtcbiAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgaWYgKCFzb3VyY2UucmVhZGFibGVFbmRlZCkgZmFpbChuZXcgRXJyb3IoXCJEaWFnbm9zdGljIHNvdXJjZSBjbG9zZWQgYmVmb3JlIGl0cyBvdXRwdXQgd2FzIGRyYWluZWRcIikpO1xuICB9O1xuICBzb3VyY2Uub24oXCJlcnJvclwiLCBmYWlsKTtcbiAgc291cmNlLm9uKFwiY2xvc2VcIiwgY2xvc2UpO1xuICBkZXN0aW5hdGlvbi5vbihcImVycm9yXCIsIGZhaWwpO1xuICBjb25zdCBjb21wbGV0aW9uID0gZmluaXNoZWQocmVkYWN0b3IsIHsgY2xlYW51cDogdHJ1ZSB9KS5maW5hbGx5KCgpID0+IHtcbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBmYWlsKTtcbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoXCJjbG9zZVwiLCBjbG9zZSk7XG4gICAgZGVzdGluYXRpb24ucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBmYWlsKTtcbiAgfSk7XG4gIHNvdXJjZS5waXBlKHJlZGFjdG9yKS5waXBlKGRlc3RpbmF0aW9uLCB7IGVuZDogZmFsc2UgfSk7XG4gIHJldHVybiBjb21wbGV0aW9uO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxpQkFBdUU7QUFDaEYsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxnQ0FBZ0M7QUFFbEMsTUFBTSxrQkFDWDtBQUNLLE1BQU0sV0FBVyxDQUFDLFNBQ3ZCLHlCQUF5QixJQUFJLEVBQUUsUUFBUSxZQUFZLENBQUMsTUFBTyxNQUFNLFFBQVEsTUFBTSxNQUFPLElBQUksRUFBRztBQUN4RixTQUFTLGFBQWEsTUFBeUIsUUFBUSxLQUFlO0FBQzNFLFNBQU8sT0FBTyxRQUFRLEdBQUcsRUFBRTtBQUFBLElBQVEsQ0FBQyxDQUFDLEtBQUssS0FBSyxNQUM3Qyw4REFBOEQsS0FBSyxHQUFHLEtBQ3RFLFNBQ0EsTUFBTSxVQUFVLEtBQ2hCLE1BQU0sVUFBVSxRQUNaLENBQUMsS0FBSyxJQUNOLENBQUM7QUFBQSxFQUNQO0FBQ0Y7QUFDTyxTQUFTLE9BQU8sTUFBYyxVQUFVLGFBQWEsR0FBVztBQUNyRSxNQUFJLFNBQVM7QUFDYixhQUFXLFVBQVUsQ0FBQyxHQUFHLE9BQU8sRUFBRSxLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsU0FBUyxFQUFFLE1BQU07QUFDbEUsYUFBUyxPQUFPLE1BQU0sTUFBTSxFQUFFLEtBQUssWUFBWTtBQUNqRCxTQUFPLE9BQ0osUUFBUSwwQkFBMEIsQ0FBQ0EsVUFBUztBQUMzQyxRQUFJO0FBQ0YsWUFBTSxNQUFNLElBQUksSUFBSUEsS0FBSTtBQUN4QixhQUFPLElBQUksU0FBUyxJQUFJO0FBQUEsSUFDMUIsUUFBUTtBQUNOLGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRixDQUFDLEVBQ0E7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ZUFBZSxVQUFVLE9BQU8sVUFBVSxNQUFNLFFBQVEsVUFBVSxNQUFNLFFBQVE7QUFDckYsV0FBSyxXQUFXLE9BQU8sS0FBSyxNQUFNLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxVQUFVLEtBQUssTUFBTTtBQUNoRSxXQUFLLFVBQVU7QUFBQSxJQUNqQixPQUFPO0FBRUwsWUFBTSxTQUFTLE9BQU8sUUFBUSxLQUFLLFFBQVEsTUFBTSxHQUFHLE1BQU0sS0FBSyxJQUFJLEtBQUssU0FBUyxLQUFLLE9BQU87QUFDN0YsV0FBSyxVQUFVLFVBQVUsUUFBUSxDQUFDLEtBQUs7QUFDdkMsWUFBTSxVQUFVLE9BQU8sWUFBWSxJQUFJO0FBQ3ZDLFlBQU0sTUFBTSxLQUFLO0FBQUEsUUFDZixPQUFPO0FBQUEsUUFDUCxXQUFXLEtBQUssQ0FBQyxLQUFLLFlBQVksVUFBVSxJQUFJLEtBQUssSUFBSSxHQUFHLEtBQUssUUFBUSxTQUFTLEtBQUssT0FBTztBQUFBLE1BQ2hHO0FBQ0EsV0FBSyxLQUFLLEtBQUssUUFBUSxNQUFNLEdBQUcsR0FBRyxDQUFDO0FBQ3BDLFdBQUssVUFBVSxLQUFLLFFBQVEsTUFBTSxHQUFHO0FBQUEsSUFDdkM7QUFDQSxhQUFTO0FBQUEsRUFDWDtBQUFBLEVBQ1MsT0FBTyxVQUFtQztBQUNqRCxRQUFJLENBQUMsS0FBSyxhQUFjLE1BQUssS0FBSyxPQUFPLEtBQUssVUFBVSxLQUFLLFFBQVEsSUFBSSxHQUFHLEtBQUssT0FBTyxDQUFDO0FBQ3pGLGFBQVM7QUFBQSxFQUNYO0FBQ0Y7QUFHTyxTQUFTLHVCQUF1QixRQUFrQixhQUF1QixTQUFtQztBQUNqSCxRQUFNLFdBQVcsSUFBSSxtQkFBbUIsT0FBTztBQUMvQyxRQUFNLE9BQU8sQ0FBQyxVQUFpQjtBQUM3QixXQUFPLE9BQU8sUUFBUTtBQUN0QixhQUFTLE9BQU8sV0FBVztBQUMzQixhQUFTLFFBQVEsS0FBSztBQUN0QixXQUFPLE9BQU87QUFBQSxFQUNoQjtBQUNBLFFBQU0sUUFBUSxNQUFNO0FBQ2xCLFFBQUksQ0FBQyxPQUFPLGNBQWUsTUFBSyxJQUFJLE1BQU0sd0RBQXdELENBQUM7QUFBQSxFQUNyRztBQUNBLFNBQU8sR0FBRyxTQUFTLElBQUk7QUFDdkIsU0FBTyxHQUFHLFNBQVMsS0FBSztBQUN4QixjQUFZLEdBQUcsU0FBUyxJQUFJO0FBQzVCLFFBQU0sYUFBYSxTQUFTLFVBQVUsRUFBRSxTQUFTLEtBQUssQ0FBQyxFQUFFLFFBQVEsTUFBTTtBQUNyRSxXQUFPLGVBQWUsU0FBUyxJQUFJO0FBQ25DLFdBQU8sZUFBZSxTQUFTLEtBQUs7QUFDcEMsZ0JBQVksZUFBZSxTQUFTLElBQUk7QUFBQSxFQUMxQyxDQUFDO0FBQ0QsU0FBTyxLQUFLLFFBQVEsRUFBRSxLQUFLLGFBQWEsRUFBRSxLQUFLLE1BQU0sQ0FBQztBQUN0RCxTQUFPO0FBQ1Q7IiwibmFtZXMiOlsidGV4dCJdLCJmaWxlIjoic2NyaXB0cy9kaWFnbm9zdGljLXRleHQubWpzIn0=
