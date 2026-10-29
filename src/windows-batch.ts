/** Quote for the Windows executable parser, then escape both cmd.exe passes through a batch shim.
 * The two parsing boundaries follow npm's @npmcli/promise-spawn Windows command contract.
 */
export function windowsBatchArgument(value: string): string {
  if (!value) return '""';
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  const escape = (text: string) => text.replace(/[ !%^&()<>|"\t]/g, "^$&");
  return escape(escape(quoted));
}
