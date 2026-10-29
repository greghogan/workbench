import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function available(command: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    const suffixes = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
    return suffixes.some((suffix) => {
      try {
        return statSync(join(directory, command + suffix)).isFile();
      } catch {
        return false;
      }
    });
  });
}
