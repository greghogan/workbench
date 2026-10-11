import { required } from "./invariants.js";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readText } from "./core.js";

/** Console fences are executable contracts: one shell command and its complete stdout. */
export function checkDocExamples(file: string): void {
  const path = resolve(file);
  const blocks = [...readText(path).matchAll(/^```console\r?\n\$ ([^\r\n]+)\r?\n([\s\S]*?)^```/gm)];
  if (!blocks.length) throw new Error(`${file}: no executable console examples`);
  for (const block of blocks) {
    const result = spawnSync("sh", ["-eu", "-c", required(block[1], "expected block[1]")], {
      cwd: dirname(path),
      encoding: "utf8",
    });
    if (
      result.error ||
      result.status !== 0 ||
      result.stderr ||
      result.stdout.replaceAll("\r\n", "\n") !== required(block[2], "expected block[2]").replaceAll("\r\n", "\n")
    )
      throw new Error(
        `${file}: example failed: ${String(block[1])}\n${result.error ?? ""}${result.stderr}\nExpected stdout:\n${String(block[2])}Actual stdout:\n${result.stdout}`,
      );
  }
  console.log(`Verified ${String(blocks.length)} console examples in ${file}.`);
}
