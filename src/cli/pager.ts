import { emitKeypressEvents, type Key } from "node:readline";
import { plainOutput } from "../presentation.js";
import { safeOutput } from "../terminal-output.js";
import { fitTerminalText, wrapTerminalText } from "../terminal-text.js";
import { terminalAvailable, type TerminalInput, type TerminalOutput } from "../terminal-choice.js";

/** Wrap conservatively without splitting graphemes or losing text between terminal pages. */
export function helpLines(text: string, width: number): string[] {
  return safeOutput(text)
    .replaceAll("\t", "    ")
    .split("\n")
    .flatMap((line) => wrapTerminalText(line, width));
}
export async function pageHelp(
  text: string,
  disabled = false,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Promise<void> {
  const width = () => Math.max(1, (output.columns ?? 80) - 1);
  const height = () => Math.max(1, (output.rows ?? 24) - 1);
  if (disabled || !terminalAvailable(input, output) || plainOutput() || process.env.TERM === "dumb") {
    output.write(text);
    return;
  }
  let wrappedWidth = width(),
    wrapped = helpLines(text, wrappedWidth);
  const layout = () => {
    const columns = width();
    if (columns !== wrappedWidth) {
      wrappedWidth = columns;
      wrapped = helpLines(text, columns);
    }
    return wrapped;
  };
  if (layout().length <= height()) {
    output.write(text);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const raw = input.isRaw,
      flowing = input.readableFlowing;
    let first = 0,
      done = false;
    const finish = (failure?: unknown) => {
      if (done) return;
      done = true;
      input.removeListener("keypress", keypress);
      input.removeListener("end", ended);
      input.removeListener("error", failed);
      output.removeListener("error", failed);
      output.removeListener("resize", draw);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      try {
        input.setRawMode(raw);
        if (!flowing) input.pause();
        output.write("\u001b[?25h\u001b[?1049l");
      } catch (cleanup) {
        failure ??= cleanup;
      }
      if (failure) reject(failure instanceof Error ? failure : new Error("Help pager failed", { cause: failure }));
      else resolve();
    };
    function draw() {
      try {
        const lines = layout(),
          count = height();
        first = Math.max(0, Math.min(first, Math.max(0, lines.length - count)));
        output.write(
          "\u001b[H\u001b[2J" +
            lines.slice(first, first + count).join("\n") +
            "\n" +
            fitTerminalText(
              `${String(first + 1)}–${String(Math.min(first + count, lines.length))}/${String(lines.length)}  Space/PgDn next; PgUp back; arrows scroll; q exits`,
              width(),
            ),
        );
      } catch (error) {
        finish(error);
      }
    }
    function keypress(_text: string, key: Key) {
      if (key.name === "q" || key.name === "escape") {
        finish();
        return;
      }
      if (key.ctrl && key.name === "c") {
        interrupt();
        return;
      }
      const lines = layout();
      if (["space", "pagedown"].includes(key.name ?? "")) {
        if (first + height() >= lines.length) {
          finish();
          return;
        }
        first += height();
      } else if (key.name === "pageup" || key.name === "b") first -= height();
      else if (key.name === "up") first--;
      else if (key.name === "down" || key.name === "return") first++;
      else if (key.name === "home") first = 0;
      else if (key.name === "end") first = lines.length;
      else return;
      draw();
    }
    const ended = () => {
      finish();
    };
    const failed = (error: Error) => {
      finish(error);
    };
    const interrupt = () => {
      process.exitCode = 130;
      finish();
    };
    const terminate = () => {
      process.exitCode = 143;
      finish();
    };
    try {
      emitKeypressEvents(input);
      input.on("keypress", keypress).once("end", ended).once("error", failed);
      output.once("error", failed).on("resize", draw);
      process.once("SIGINT", interrupt).once("SIGTERM", terminate);
      input.setRawMode(true);
      input.resume();
      output.write("\u001b[?1049h\u001b[?25l");
      draw();
    } catch (error) {
      finish(error);
    }
  });
}
