/** Quote one argument for a Windows executable, independently of shell or batch-file escaping. */
export function windowsExecutableArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
