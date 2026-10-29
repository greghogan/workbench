import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { BoundedState } from "../src/bounded-state.ts";
import * as files from "../src/file-reads.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-state-race-"));
  temporary.push(directory);
  const path = join(directory, "state.json");
  const state = new BoundedState(
    () => path,
    1024,
    (value) => {
      if (typeof value !== "number") throw new Error("Invalid numeric state");
      return value;
    },
    () => 0,
  );
  state.write(1);
  return { path, state };
}
test("a state read retries transient replacement and decodes the complete replacement", () => {
  const { state } = fixture();
  const read = vi.spyOn(files, "readBoundedFile").mockImplementationOnce(() => {
    state.write(2);
    throw new files.FileChanged("State replaced during read");
  });
  expect(state.read()).toBe(2);
  expect(read).toHaveBeenCalledTimes(2);
});
test("persistent changes remain bounded and malformed stable state is not retried", () => {
  const { state, path } = fixture();
  const read = vi.spyOn(files, "readBoundedFile").mockImplementation(() => {
    throw new files.FileChanged("Still changing");
  });
  expect(() => state.read()).toThrow("Still changing");
  expect(read).toHaveBeenCalledTimes(3);
  read.mockRestore();
  const stable = vi.spyOn(files, "readBoundedFile");
  writeFileSync(path, "{}");
  expect(() => state.read()).toThrow("Invalid numeric state");
  expect(stable).toHaveBeenCalledOnce();
});
