import { createInterface } from "node:readline/promises";
import { plainOutput } from "../../core/diagnostics/presentation.js";

export async function prompt(label: string, suggested = ""): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!suggested) throw new Error(`${label} requires an interactive terminal or explicit arguments`);
    return suggested;
  }
  const interface_ = createInterface({
    input: process.stdin,
    output: process.stdout,
    ...(plainOutput() ? { terminal: false } : {}),
  });
  try {
    return (await interface_.question(`${label}${suggested ? ` [${suggested}]` : ""}: `)).trim() || suggested;
  } finally {
    interface_.close();
  }
}
