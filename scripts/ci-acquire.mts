import { acquireCommand } from "./network-command.mts";
import { runCIEntry } from "./ci-errors.mts";

const [label, command, ...args] = process.argv.slice(2);
if (!label || !command) throw new Error("Supply an acquisition label, executable, and its arguments");
await runCIEntry(label, async () => {
  await acquireCommand(label, command, args);
});
