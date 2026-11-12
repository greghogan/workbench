export type Validation = (condition: unknown, field: string, expected: string) => asserts condition;
/** Boundary errors carry a field; the storage or transport owner supplies its own outer context. */
export function validation(
  context: string,
  problem: (message: string) => Error = (message) => new Error(message),
): Validation {
  return (condition, field, expected): asserts condition => {
    if (!condition) throw problem(`${context}: ${field} ${expected}`);
  };
}
