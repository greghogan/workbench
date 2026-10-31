import { windowsExecutableArgument } from "../scripts/windows-arguments.mjs";

/** Quote for the Windows executable parser, then escape both cmd.exe passes through a batch shim.
 * The two parsing boundaries follow npm's @npmcli/promise-spawn Windows command contract.
 */
export function windowsBatchArgument(value: string): string {
  if (!value) return '""';
  const quoted = windowsExecutableArgument(value);
  const escape = (text: string) => text.replace(/[ !%^&()<>|"\t]/g, "^$&");
  return escape(escape(quoted));
}
