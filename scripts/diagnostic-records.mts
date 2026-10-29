import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { readDiagnosticEvent, renderDiagnosticEvent, LogFormat } from "./diagnostics.mjs";

/** Canonical diagnostic JSONL is sanitized as records, preserving quoting and independent parsing. */
export class DiagnosticRecordStream extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private record(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 16384) throw new Error("diagnostic JSON record exceeds 16 KiB");
    const event = readDiagnosticEvent(JSON.parse(line));
    if (!event) throw new Error("invalid diagnostic JSON record; preserving source evidence");
    this.push(renderDiagnosticEvent(event, LogFormat.Json));
  }
  override _transform(bytes: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const lines = (this.pending + this.decoder.write(bytes)).split("\n");
      this.pending = lines.pop() ?? "";
      if (Buffer.byteLength(this.pending) > 16384) throw new Error("diagnostic JSON record exceeds 16 KiB");
      for (const line of lines) this.record(line);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
  override _flush(callback: TransformCallback): void {
    try {
      this.record(this.pending + this.decoder.end());
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
