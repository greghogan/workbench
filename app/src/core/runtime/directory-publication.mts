import { existsSync, renameSync } from "node:fs";

/** The caller validates output ownership and retains recovery paths until replacement succeeds. */
export function publishDirectory(incoming: string, destination: string, previous: string): void {
  if (existsSync(previous)) throw new Error(`Preserving existing recovery directory: ${previous}`);
  const replacing = existsSync(destination);
  if (replacing) renameSync(destination, previous);
  try {
    renameSync(incoming, destination);
  } catch (failure) {
    if (replacing)
      try {
        renameSync(previous, destination);
      } catch (recovery) {
        throw new AggregateError(
          [failure, recovery],
          `Directory replacement failed; previous output retained at ${previous}`,
          { cause: recovery },
        );
      }
    throw failure;
  }
}
