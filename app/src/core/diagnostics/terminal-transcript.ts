import { finished } from "node:stream/promises";
import { DiagnosticRedactor, secretValues } from "./diagnostics.mjs";
import { BoundedDiagnosticWriter } from "./diagnostic-writer.mjs";
import { terminalChannels } from "../storage/logs/terminal-log.js";
import type { DiagnosticLog } from "../storage/logs/diagnostic-log.js";

/** Tee service output before it leaves Node. Keep the original streams and their backpressure intact. */
export function captureTerminal(file: DiagnosticLog) {
  const secrets = secretValues();
  const channels = terminalChannels.map((channel) => {
    const stream = process[channel],
      original = Object.getOwnPropertyDescriptor(stream, "write"),
      forward = stream.write.bind(stream);
    const writer = new BoundedDiagnosticWriter(file, (omitted) =>
      file.encodeTerminal(channel, `\n[${String(omitted)} terminal output chunks omitted by backpressure]\n`),
    );
    const redact = new DiagnosticRedactor(secrets);
    redact.on("data", (chunk: Buffer) => {
      writer.write(file.encodeTerminal(channel, chunk.toString()));
    });
    redact.on("error", (error: Error) => {
      file.recordIssue(error);
      file.destroy(error);
    });
    type Callback = (error?: Error | null) => void;
    const write: typeof stream.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | Callback,
      callback?: Callback,
    ) => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const accepted = forward(
        chunk,
        encoding,
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback,
      );
      if (!file.destroyed && !redact.destroyed) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
        // Bound processing and redaction even when a producer supplies a large single write.
        for (let offset = 0; offset < bytes.length; offset += 16384)
          redact.write(bytes.subarray(offset, offset + 16384));
      }
      return accepted;
    };
    stream.write = write;
    return {
      async close() {
        if (stream.write === write) {
          if (original) Object.defineProperty(stream, "write", original);
          else Reflect.deleteProperty(stream, "write");
        }
        try {
          const drained = finished(redact);
          redact.end();
          await drained.catch((error: unknown) => {
            file.recordIssue(error);
          });
          writer.flushOmissions(true);
          if (writer.omitted)
            file.recordIssue(new Error(`${String(writer.omitted)} ${channel} chunks omitted by backpressure`));
        } finally {
          writer.dispose();
        }
      },
    };
  });
  return () => Promise.all(channels.map((channel) => channel.close()));
}
