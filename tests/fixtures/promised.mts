/** Preserve immediate fixture effects while exposing their value or throw as a promise. */
export function promised<T>(action: () => T | PromiseLike<T>): Promise<T> {
  return new Promise((resolve) => {
    resolve(action());
  });
}
