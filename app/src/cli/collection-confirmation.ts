import { prompt } from "./terminal/project-prompt.js";
import { terminalAvailable } from "./terminal/terminal-choice.js";

export async function confirmCollectionAcceptance(label: string, yes?: boolean): Promise<boolean> {
  if (yes !== undefined) return yes;
  if (!terminalAvailable()) return false;
  return /^(?:y|yes)$/i.test(await prompt(`Accept all ADRs in ${label}?`, "no"));
}
