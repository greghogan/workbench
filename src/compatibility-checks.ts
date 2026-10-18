import { resolve } from "node:path";
import { readChecks, type ConfiguredCheck } from "./checks.js";
import { InvalidInput } from "./input-errors.js";

/** Compatibility commands follow the same complete language selection as ordinary checks. */
export function compatibilityChecks(root: string, path: string, checks: ConfiguredCheck[] = readChecks(root)) {
  const directory = resolve(root, path);
  const selected = checks.filter((check) => check.directory === directory);
  const setup = selected.filter((check) => check.role === "compatibility-setup");
  const tests = selected.filter((check) => check.role === "compatibility-test");
  if (!tests.length)
    throw new InvalidInput(
      `${path}: declare compatibility-test commands in the selected language or project automation`,
    );
  return [...setup, ...tests];
}

export function compatibilityArguments(command: string[], runtime: string, version: string): string[] {
  return command.map((part) => part.replaceAll("{runtime}", runtime).replaceAll("{runtimeVersion}", version));
}
