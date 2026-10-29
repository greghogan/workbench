/** @param {readonly number[]} values @returns {number} */
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** @param {Uint8Array} data @param {number} needle @returns {number} */
export function countByte(data, needle) {
  if (!Number.isInteger(needle) || needle < 0 || needle > 255) {
    throw new RangeError("needle must be a byte (0 through 255)");
  }
  let count = 0;
  for (const value of data) {
    if (value === needle) count++;
  }
  return count;
}
