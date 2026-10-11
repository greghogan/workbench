import type { Command } from "commander";
import type { CISelectionOptions } from "./ci-selection.js";

const options: [keyof CISelectionOptions, string, string][] = [
  ["affected", "--affected", "Select affected roots, with conservative full-matrix fallback"],
  ["base", "--base <revision>", "Compare against this revision; includes local changes unless --head is given"],
  ["head", "--head <revision>", "Compare committed revisions instead of the working tree"],
  ["mergeBase", "--merge-base", "Compare against the common ancestor of base and head"],
  ["full", "--full", "Explicitly select every configured root"],
  ["explainFiles", "--explain-files", "Include changed and matched filenames in structured reports"],
];

export function addCISelectionOptions(command: Command): Command {
  for (const [, flag, description] of options) command.option(flag, description);
  return command;
}

/** Forward comparison options through the scheduler boundary as structured arguments. */
export function ciSelectionArguments(selection: CISelectionOptions): string[] {
  return options.flatMap(([key, flag]) => {
    const value = selection[key];
    const name = flag.split(" ")[0] ?? flag;
    return typeof value === "string" ? [name, value] : value ? [name] : [];
  });
}
