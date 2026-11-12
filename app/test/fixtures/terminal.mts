import { PassThrough } from "node:stream";

/** In-memory terminal implementing the stream operations used by interactive selectors. */
export function terminal(columns = 100, rows = 12) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
  let text = "";
  output.on("data", (data: Buffer) => {
    text += data.toString("utf8");
  });
  return {
    input,
    output,
    text: () => text,
    key: (name: string, ctrl = false) => input.emit("keypress", "", { name, ctrl }),
  };
}

// Node's global process getters promise actual TTY classes. The test streams above
// intentionally provide the behavioral subset; the cast is limited to that boundary.
export const processInput = (input: ReturnType<typeof terminal>["input"]) => input as unknown as typeof process.stdin;
export const processOutput = (output: ReturnType<typeof terminal>["output"]) =>
  output as unknown as typeof process.stdout;
