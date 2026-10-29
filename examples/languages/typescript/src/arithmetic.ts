export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function countByte(data: Uint8Array, needle: number): number {
  if (!Number.isInteger(needle) || needle < 0 || needle > 255) {
    throw new RangeError("needle must be a byte (0 through 255)");
  }
  let count = 0;
  for (const value of data) {
    if (value === needle) count++;
  }
  return count;
}
