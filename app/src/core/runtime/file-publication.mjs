// Generated from file-publication.mts; edit the TypeScript source.
import { errorFrom } from "./values.mjs";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  linkSync,
  existsSync,
  fstatSync,
  readSync,
  constants
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
const publicationTemporaryGlob = ".*.????????-????-????-????-????????????.tmp";
const retryWait = new Int32Array(new SharedArrayBuffer(4));
function replaceFile(temporary, path, beforeReplace) {
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    beforeReplace?.();
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      const code = error.code;
      if (process.platform !== "win32" || code !== "EACCES" && code !== "EPERM" && code !== "EBUSY") throw error;
      if (attempt === attempts)
        throw new Error(`Atomic replacement failed after ${String(attempt)} attempts: ${path}`, { cause: error });
      Atomics.wait(retryWait, 0, 0, Math.min(25 * 2 ** (attempt - 1), 200));
    }
  }
}
function publicationTarget(path) {
  const match = /^\.(.+)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(basename(path));
  return match?.[1] ? join(dirname(path), match[1]) : void 0;
}
function stageFile(path, contents, mode, options = {}) {
  if (options.createParent !== false) mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor = openSync(temporary, "wx", mode);
  const staged = {
    path,
    temporary,
    publish(beforeReplace) {
      replaceFile(temporary, path, beforeReplace);
    },
    discard() {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
  try {
    if (typeof contents === "function") contents(descriptor);
    else writeFileSync(descriptor, contents);
    if (mode !== void 0) fchmodSync(descriptor, mode);
    const written = descriptor;
    descriptor = void 0;
    closeSync(written);
    return staged;
  } catch (error) {
    const failures = [];
    if (descriptor !== void 0)
      try {
        closeSync(descriptor);
      } catch (cleanup) {
        failures.push(cleanup);
      }
    try {
      staged.discard();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length)
      throw combineFailures(
        error,
        new AggregateError(failures, `Temporary file cleanup failed: ${temporary}`),
        "File preparation and cleanup failed"
      );
    throw error;
  }
}
function publish(staged, action) {
  let failure;
  let failed = false;
  try {
    action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    staged.discard();
  } catch (cleanup) {
    if (failed) throw combineFailures(failure, cleanup, `File publication and cleanup failed: ${staged.temporary}`);
    throw cleanup;
  }
  if (failed) throw errorFrom(failure);
}
function writeAtomic(path, contents, mode, beforeReplace, options = {}) {
  const staged = stageFile(path, contents, mode, options);
  publish(staged, () => {
    staged.publish(beforeReplace);
  });
}
function writeNew(path, contents, mode) {
  const staged = stageFile(path, contents, mode);
  publish(staged, () => {
    linkSync(staged.temporary, path);
  });
}
function publishFile(path, contents, expected, mode) {
  publishCheckedFiles([{ path, contents, expected, ...mode === void 0 ? {} : { mode } }]);
}
function matchesFile(path, expected) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
    );
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error.code ?? "")) return false;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== expected.byteLength) return false;
    const buffer = Buffer.alloc(Math.min(64 * 1024, expected.byteLength + 1));
    let offset = 0;
    for (; ; ) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      if (offset + count > expected.byteLength || !buffer.subarray(0, count).equals(expected.subarray(offset, offset + count)))
        return false;
      offset += count;
    }
    const after = fstatSync(descriptor);
    return offset === expected.byteLength && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  } finally {
    closeSync(descriptor);
  }
}
function publishCheckedFiles(files, validate, published) {
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate checked output path");
  const check = (file) => {
    validate?.(file.path);
    if (file.expected === void 0 ? existsSync(file.path) : !matchesFile(file.path, file.expected))
      throw new Error(`${file.path}: file changed before replacement; preserve the changes and inspect a fresh plan`);
  };
  for (const file of files) check(file);
  const staged = [], completed = [], errors = [];
  try {
    for (const file of files) staged.push({ file, stage: stageFile(file.path, file.contents, file.mode) });
    for (const { file, stage } of staged) {
      if (file.expected === void 0) {
        check(file);
        linkSync(stage.temporary, file.path);
      } else
        stage.publish(() => {
          check(file);
        });
      completed.push(file.path);
      published?.(file.path);
    }
  } catch (error) {
    errors.push(error);
  }
  for (const { stage } of staged)
    try {
      stage.discard();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length === 1 && completed.length === 0) throw errorFrom(errors[0]);
  if (errors.length)
    throw new AggregateError(
      errors,
      `${errorFrom(errors[0]).message}; published files: ${completed.join(", ") || "none"}`,
      {
        cause: errors[0]
      }
    );
}
export {
  publicationTarget,
  publicationTemporaryGlob,
  publishCheckedFiles,
  publishFile,
  stageFile,
  writeAtomic,
  writeNew
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGUtcHVibGljYXRpb24ubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZmNobW9kU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgbGlua1N5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIGZzdGF0U3luYyxcbiAgcmVhZFN5bmMsXG4gIGNvbnN0YW50cyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4uL2RpYWdub3N0aWNzL2RpYWdub3N0aWMtZXJyb3JzLm1qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0YWdlZEZpbGUge1xuICByZWFkb25seSB0ZW1wb3Jhcnk6IHN0cmluZztcbiAgcmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuICBwdWJsaXNoKGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkKTogdm9pZDtcbiAgZGlzY2FyZCgpOiB2b2lkO1xufVxuZXhwb3J0IGludGVyZmFjZSBQdWJsaWNhdGlvbk9wdGlvbnMge1xuICBjcmVhdGVQYXJlbnQ/OiBib29sZWFuO1xufVxuZXhwb3J0IHR5cGUgRmlsZUNvbnRlbnRzID0gc3RyaW5nIHwgVWludDhBcnJheSB8ICgoZGVzY3JpcHRvcjogbnVtYmVyKSA9PiB2b2lkKTtcbmV4cG9ydCBjb25zdCBwdWJsaWNhdGlvblRlbXBvcmFyeUdsb2IgPSBcIi4qLj8/Pz8/Pz8/LT8/Pz8tPz8/Py0/Pz8/LT8/Pz8/Pz8/Pz8/Py50bXBcIjtcbmNvbnN0IHJldHJ5V2FpdCA9IG5ldyBJbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcig0KSk7XG5cbi8qKiBXaW5kb3dzIHJlYWRlcnMgYW5kIHNjYW5uZXJzIGNhbiB0ZW1wb3JhcmlseSBkZW55IHJlcGxhY2VtZW50OyBuZXZlciB1bmxpbmsgdGhlIGRlc3RpbmF0aW9uLiAqL1xuZnVuY3Rpb24gcmVwbGFjZUZpbGUodGVtcG9yYXJ5OiBzdHJpbmcsIHBhdGg6IHN0cmluZywgYmVmb3JlUmVwbGFjZT86ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgY29uc3QgYXR0ZW1wdHMgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyA4IDogMTtcbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDE7IGF0dGVtcHQgPD0gYXR0ZW1wdHM7IGF0dGVtcHQrKykge1xuICAgIC8vIEEgY29uZmxpY3RpbmcgZWRpdCBkdXJpbmcgYSBzaGFyaW5nIHZpb2xhdGlvbiBtdXN0IHN0aWxsIHByZXZlbnQgcHVibGljYXRpb24uXG4gICAgYmVmb3JlUmVwbGFjZT8uKCk7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCBwYXRoKTtcbiAgICAgIHJldHVybjtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgY29kZSA9IChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiIHx8IChjb2RlICE9PSBcIkVBQ0NFU1wiICYmIGNvZGUgIT09IFwiRVBFUk1cIiAmJiBjb2RlICE9PSBcIkVCVVNZXCIpKSB0aHJvdyBlcnJvcjtcbiAgICAgIGlmIChhdHRlbXB0ID09PSBhdHRlbXB0cylcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBdG9taWMgcmVwbGFjZW1lbnQgZmFpbGVkIGFmdGVyICR7U3RyaW5nKGF0dGVtcHQpfSBhdHRlbXB0czogJHtwYXRofWAsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgICAgQXRvbWljcy53YWl0KHJldHJ5V2FpdCwgMCwgMCwgTWF0aC5taW4oMjUgKiAyICoqIChhdHRlbXB0IC0gMSksIDIwMCkpO1xuICAgIH1cbiAgfVxufVxuXG4vKiogSWRlbnRpZnkgb25seSB0aGUgVVVJRCBjYW5kaWRhdGUgbmFtZXMgb3duZWQgYnkgdGhpcyBwdWJsaXNoZXIuICovXG5leHBvcnQgZnVuY3Rpb24gcHVibGljYXRpb25UYXJnZXQocGF0aDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWF0Y2ggPSAvXlxcLiguKylcXC5bYS1mMC05XXs4fS1bYS1mMC05XXs0fS1bYS1mMC05XXs0fS1bYS1mMC05XXs0fS1bYS1mMC05XXsxMn1cXC50bXAkLy5leGVjKGJhc2VuYW1lKHBhdGgpKTtcbiAgcmV0dXJuIG1hdGNoPy5bMV0gPyBqb2luKGRpcm5hbWUocGF0aCksIG1hdGNoWzFdKSA6IHVuZGVmaW5lZDtcbn1cbi8qKiBGaW5pc2ggd3JpdGluZyBhbmQgY2xvc2luZyBldmVyeSBjYW5kaWRhdGUgYmVmb3JlIHB1Ymxpc2hpbmcgYSBiYXRjaC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFnZUZpbGUoXG4gIHBhdGg6IHN0cmluZyxcbiAgY29udGVudHM6IEZpbGVDb250ZW50cyxcbiAgbW9kZT86IG51bWJlcixcbiAgb3B0aW9uczogUHVibGljYXRpb25PcHRpb25zID0ge30sXG4pOiBTdGFnZWRGaWxlIHtcbiAgaWYgKG9wdGlvbnMuY3JlYXRlUGFyZW50ICE9PSBmYWxzZSkgbWtkaXJTeW5jKGRpcm5hbWUocGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCB0ZW1wb3JhcnkgPSBqb2luKGRpcm5hbWUocGF0aCksIGAuJHtiYXNlbmFtZShwYXRoKX0uJHtyYW5kb21VVUlEKCl9LnRtcGApO1xuICBsZXQgZGVzY3JpcHRvcjogbnVtYmVyIHwgdW5kZWZpbmVkID0gb3BlblN5bmModGVtcG9yYXJ5LCBcInd4XCIsIG1vZGUpO1xuICBjb25zdCBzdGFnZWQ6IFN0YWdlZEZpbGUgPSB7XG4gICAgcGF0aCxcbiAgICB0ZW1wb3JhcnksXG4gICAgcHVibGlzaChiZWZvcmVSZXBsYWNlKSB7XG4gICAgICByZXBsYWNlRmlsZSh0ZW1wb3JhcnksIHBhdGgsIGJlZm9yZVJlcGxhY2UpO1xuICAgIH0sXG4gICAgZGlzY2FyZCgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHVubGlua1N5bmModGVtcG9yYXJ5KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlICE9PSBcIkVOT0VOVFwiKSB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xuICB0cnkge1xuICAgIGlmICh0eXBlb2YgY29udGVudHMgPT09IFwiZnVuY3Rpb25cIikgY29udGVudHMoZGVzY3JpcHRvcik7XG4gICAgZWxzZSB3cml0ZUZpbGVTeW5jKGRlc2NyaXB0b3IsIGNvbnRlbnRzKTtcbiAgICBpZiAobW9kZSAhPT0gdW5kZWZpbmVkKSBmY2htb2RTeW5jKGRlc2NyaXB0b3IsIG1vZGUpO1xuICAgIGNvbnN0IHdyaXR0ZW4gPSBkZXNjcmlwdG9yO1xuICAgIGRlc2NyaXB0b3IgPSB1bmRlZmluZWQ7IC8vIEEgZmFpbGVkIGNsb3NlIG1heSBoYXZlIHJlbGVhc2VkIGl0cyBkZXNjcmlwdG9yIGFscmVhZHkuXG4gICAgY2xvc2VTeW5jKHdyaXR0ZW4pO1xuICAgIHJldHVybiBzdGFnZWQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc3QgZmFpbHVyZXM6IHVua25vd25bXSA9IFtdO1xuICAgIGlmIChkZXNjcmlwdG9yICE9PSB1bmRlZmluZWQpXG4gICAgICB0cnkge1xuICAgICAgICBjbG9zZVN5bmMoZGVzY3JpcHRvcik7XG4gICAgICB9IGNhdGNoIChjbGVhbnVwKSB7XG4gICAgICAgIGZhaWx1cmVzLnB1c2goY2xlYW51cCk7XG4gICAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHN0YWdlZC5kaXNjYXJkKCk7XG4gICAgfSBjYXRjaCAoY2xlYW51cCkge1xuICAgICAgZmFpbHVyZXMucHVzaChjbGVhbnVwKTtcbiAgICB9XG4gICAgaWYgKGZhaWx1cmVzLmxlbmd0aClcbiAgICAgIHRocm93IGNvbWJpbmVGYWlsdXJlcyhcbiAgICAgICAgZXJyb3IsXG4gICAgICAgIG5ldyBBZ2dyZWdhdGVFcnJvcihmYWlsdXJlcywgYFRlbXBvcmFyeSBmaWxlIGNsZWFudXAgZmFpbGVkOiAke3RlbXBvcmFyeX1gKSxcbiAgICAgICAgXCJGaWxlIHByZXBhcmF0aW9uIGFuZCBjbGVhbnVwIGZhaWxlZFwiLFxuICAgICAgKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuZnVuY3Rpb24gcHVibGlzaChzdGFnZWQ6IFN0YWdlZEZpbGUsIGFjdGlvbjogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBsZXQgZmFpbHVyZTogdW5rbm93bjtcbiAgbGV0IGZhaWxlZCA9IGZhbHNlO1xuICB0cnkge1xuICAgIGFjdGlvbigpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGZhaWxlZCA9IHRydWU7XG4gICAgZmFpbHVyZSA9IGVycm9yO1xuICB9XG4gIHRyeSB7XG4gICAgc3RhZ2VkLmRpc2NhcmQoKTtcbiAgfSBjYXRjaCAoY2xlYW51cCkge1xuICAgIGlmIChmYWlsZWQpIHRocm93IGNvbWJpbmVGYWlsdXJlcyhmYWlsdXJlLCBjbGVhbnVwLCBgRmlsZSBwdWJsaWNhdGlvbiBhbmQgY2xlYW51cCBmYWlsZWQ6ICR7c3RhZ2VkLnRlbXBvcmFyeX1gKTtcbiAgICB0aHJvdyBjbGVhbnVwO1xuICB9XG4gIGlmIChmYWlsZWQpIHRocm93IGVycm9yRnJvbShmYWlsdXJlKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUF0b21pYyhcbiAgcGF0aDogc3RyaW5nLFxuICBjb250ZW50czogRmlsZUNvbnRlbnRzLFxuICBtb2RlPzogbnVtYmVyLFxuICBiZWZvcmVSZXBsYWNlPzogKCkgPT4gdm9pZCxcbiAgb3B0aW9uczogUHVibGljYXRpb25PcHRpb25zID0ge30sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhZ2VkID0gc3RhZ2VGaWxlKHBhdGgsIGNvbnRlbnRzLCBtb2RlLCBvcHRpb25zKTtcbiAgcHVibGlzaChzdGFnZWQsICgpID0+IHtcbiAgICBzdGFnZWQucHVibGlzaChiZWZvcmVSZXBsYWNlKTtcbiAgfSk7XG59XG4vKiogUHVibGlzaCBhIGNvbXBsZXRlbHkgd3JpdHRlbiBuZXcgZmlsZSB3aXRob3V0IHJlcGxhY2luZyBhbiBleGlzdGluZyBkZXN0aW5hdGlvbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZU5ldyhwYXRoOiBzdHJpbmcsIGNvbnRlbnRzOiBGaWxlQ29udGVudHMsIG1vZGU/OiBudW1iZXIpOiB2b2lkIHtcbiAgY29uc3Qgc3RhZ2VkID0gc3RhZ2VGaWxlKHBhdGgsIGNvbnRlbnRzLCBtb2RlKTtcbiAgcHVibGlzaChzdGFnZWQsICgpID0+IHtcbiAgICBsaW5rU3luYyhzdGFnZWQudGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSk7XG59XG4vKiogRXhwZWN0ZWQgYnl0ZXMgYXJlIGNoZWNrZWQgYXQgdGhlIGZpbmFsIHJlcGxhY2VtZW50IGJvdW5kYXJ5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1Ymxpc2hGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LFxuICBleHBlY3RlZDogVWludDhBcnJheSB8IHVuZGVmaW5lZCxcbiAgbW9kZT86IG51bWJlcixcbik6IHZvaWQge1xuICBwdWJsaXNoQ2hlY2tlZEZpbGVzKFt7IHBhdGgsIGNvbnRlbnRzLCBleHBlY3RlZCwgLi4uKG1vZGUgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBtb2RlIH0pIH1dKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDaGVja2VkRmlsZSB7XG4gIHBhdGg6IHN0cmluZztcbiAgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXk7XG4gIGV4cGVjdGVkOiBVaW50OEFycmF5IHwgdW5kZWZpbmVkO1xuICBtb2RlPzogbnVtYmVyO1xufVxuZnVuY3Rpb24gbWF0Y2hlc0ZpbGUocGF0aDogc3RyaW5nLCBleHBlY3RlZDogVWludDhBcnJheSk6IGJvb2xlYW4ge1xuICBsZXQgZGVzY3JpcHRvcjogbnVtYmVyO1xuICB0cnkge1xuICAgIGRlc2NyaXB0b3IgPSBvcGVuU3luYyhcbiAgICAgIHBhdGgsXG4gICAgICBjb25zdGFudHMuT19SRE9OTFkgfCAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gMCA6IGNvbnN0YW50cy5PX05PRk9MTE9XIHwgY29uc3RhbnRzLk9fTk9OQkxPQ0spLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKFtcIkVOT0VOVFwiLCBcIkVMT09QXCJdLmluY2x1ZGVzKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPz8gXCJcIikpIHJldHVybiBmYWxzZTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGJlZm9yZSA9IGZzdGF0U3luYyhkZXNjcmlwdG9yKTtcbiAgICBpZiAoIWJlZm9yZS5pc0ZpbGUoKSB8fCBiZWZvcmUuc2l6ZSAhPT0gZXhwZWN0ZWQuYnl0ZUxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGJ1ZmZlciA9IEJ1ZmZlci5hbGxvYyhNYXRoLm1pbig2NCAqIDEwMjQsIGV4cGVjdGVkLmJ5dGVMZW5ndGggKyAxKSk7XG4gICAgbGV0IG9mZnNldCA9IDA7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgY291bnQgPSByZWFkU3luYyhkZXNjcmlwdG9yLCBidWZmZXIsIDAsIGJ1ZmZlci5sZW5ndGgsIG51bGwpO1xuICAgICAgaWYgKCFjb3VudCkgYnJlYWs7XG4gICAgICBpZiAoXG4gICAgICAgIG9mZnNldCArIGNvdW50ID4gZXhwZWN0ZWQuYnl0ZUxlbmd0aCB8fFxuICAgICAgICAhYnVmZmVyLnN1YmFycmF5KDAsIGNvdW50KS5lcXVhbHMoZXhwZWN0ZWQuc3ViYXJyYXkob2Zmc2V0LCBvZmZzZXQgKyBjb3VudCkpXG4gICAgICApXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIG9mZnNldCArPSBjb3VudDtcbiAgICB9XG4gICAgY29uc3QgYWZ0ZXIgPSBmc3RhdFN5bmMoZGVzY3JpcHRvcik7XG4gICAgcmV0dXJuIChcbiAgICAgIG9mZnNldCA9PT0gZXhwZWN0ZWQuYnl0ZUxlbmd0aCAmJlxuICAgICAgYmVmb3JlLnNpemUgPT09IGFmdGVyLnNpemUgJiZcbiAgICAgIGJlZm9yZS5tdGltZU1zID09PSBhZnRlci5tdGltZU1zICYmXG4gICAgICBiZWZvcmUuY3RpbWVNcyA9PT0gYWZ0ZXIuY3RpbWVNc1xuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VTeW5jKGRlc2NyaXB0b3IpO1xuICB9XG59XG4vKiogUHJlZmxpZ2h0IHRoZSBmdWxsIGJhdGNoLCB0aGVuIHJlY2hlY2sgZWFjaCBmaWxlIGF0IGl0cyBmaW5hbCBwdWJsaWNhdGlvbiBib3VuZGFyeS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwdWJsaXNoQ2hlY2tlZEZpbGVzKFxuICBmaWxlczogcmVhZG9ubHkgQ2hlY2tlZEZpbGVbXSxcbiAgdmFsaWRhdGU/OiAocGF0aDogc3RyaW5nKSA9PiB2b2lkLFxuICBwdWJsaXNoZWQ/OiAocGF0aDogc3RyaW5nKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGlmIChuZXcgU2V0KGZpbGVzLm1hcCgoZmlsZSkgPT4gZmlsZS5wYXRoKSkuc2l6ZSAhPT0gZmlsZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJEdXBsaWNhdGUgY2hlY2tlZCBvdXRwdXQgcGF0aFwiKTtcbiAgY29uc3QgY2hlY2sgPSAoZmlsZTogQ2hlY2tlZEZpbGUpID0+IHtcbiAgICB2YWxpZGF0ZT8uKGZpbGUucGF0aCk7XG4gICAgaWYgKGZpbGUuZXhwZWN0ZWQgPT09IHVuZGVmaW5lZCA/IGV4aXN0c1N5bmMoZmlsZS5wYXRoKSA6ICFtYXRjaGVzRmlsZShmaWxlLnBhdGgsIGZpbGUuZXhwZWN0ZWQpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2ZpbGUucGF0aH06IGZpbGUgY2hhbmdlZCBiZWZvcmUgcmVwbGFjZW1lbnQ7IHByZXNlcnZlIHRoZSBjaGFuZ2VzIGFuZCBpbnNwZWN0IGEgZnJlc2ggcGxhbmApO1xuICB9O1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIGNoZWNrKGZpbGUpO1xuICBjb25zdCBzdGFnZWQ6IHsgZmlsZTogQ2hlY2tlZEZpbGU7IHN0YWdlOiBTdGFnZWRGaWxlIH1bXSA9IFtdLFxuICAgIGNvbXBsZXRlZDogc3RyaW5nW10gPSBbXSxcbiAgICBlcnJvcnM6IHVua25vd25bXSA9IFtdO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykgc3RhZ2VkLnB1c2goeyBmaWxlLCBzdGFnZTogc3RhZ2VGaWxlKGZpbGUucGF0aCwgZmlsZS5jb250ZW50cywgZmlsZS5tb2RlKSB9KTtcbiAgICBmb3IgKGNvbnN0IHsgZmlsZSwgc3RhZ2UgfSBvZiBzdGFnZWQpIHtcbiAgICAgIGlmIChmaWxlLmV4cGVjdGVkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY2hlY2soZmlsZSk7XG4gICAgICAgIGxpbmtTeW5jKHN0YWdlLnRlbXBvcmFyeSwgZmlsZS5wYXRoKTtcbiAgICAgIH0gZWxzZVxuICAgICAgICBzdGFnZS5wdWJsaXNoKCgpID0+IHtcbiAgICAgICAgICBjaGVjayhmaWxlKTtcbiAgICAgICAgfSk7XG4gICAgICBjb21wbGV0ZWQucHVzaChmaWxlLnBhdGgpO1xuICAgICAgcHVibGlzaGVkPy4oZmlsZS5wYXRoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZXJyb3JzLnB1c2goZXJyb3IpO1xuICB9XG4gIGZvciAoY29uc3QgeyBzdGFnZSB9IG9mIHN0YWdlZClcbiAgICB0cnkge1xuICAgICAgc3RhZ2UuZGlzY2FyZCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnJvcik7XG4gICAgfVxuICBpZiAoZXJyb3JzLmxlbmd0aCA9PT0gMSAmJiBjb21wbGV0ZWQubGVuZ3RoID09PSAwKSB0aHJvdyBlcnJvckZyb20oZXJyb3JzWzBdKTtcbiAgaWYgKGVycm9ycy5sZW5ndGgpXG4gICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKFxuICAgICAgZXJyb3JzLFxuICAgICAgYCR7ZXJyb3JGcm9tKGVycm9yc1swXSkubWVzc2FnZX07IHB1Ymxpc2hlZCBmaWxlczogJHtjb21wbGV0ZWQuam9pbihcIiwgXCIpIHx8IFwibm9uZVwifWAsXG4gICAgICB7XG4gICAgICAgIGNhdXNlOiBlcnJvcnNbMF0sXG4gICAgICB9LFxuICAgICk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLFVBQVUsU0FBUyxZQUFZO0FBQ3hDLFNBQVMsdUJBQXVCO0FBWXpCLE1BQU0sMkJBQTJCO0FBQ3hDLE1BQU0sWUFBWSxJQUFJLFdBQVcsSUFBSSxrQkFBa0IsQ0FBQyxDQUFDO0FBR3pELFNBQVMsWUFBWSxXQUFtQixNQUFjLGVBQWtDO0FBQ3RGLFFBQU0sV0FBVyxRQUFRLGFBQWEsVUFBVSxJQUFJO0FBQ3BELFdBQVMsVUFBVSxHQUFHLFdBQVcsVUFBVSxXQUFXO0FBRXBELG9CQUFnQjtBQUNoQixRQUFJO0FBQ0YsaUJBQVcsV0FBVyxJQUFJO0FBQzFCO0FBQUEsSUFDRixTQUFTLE9BQU87QUFDZCxZQUFNLE9BQVEsTUFBZ0M7QUFDOUMsVUFBSSxRQUFRLGFBQWEsV0FBWSxTQUFTLFlBQVksU0FBUyxXQUFXLFNBQVMsUUFBVSxPQUFNO0FBQ3ZH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TTtBQUFBLEVBRTdCLFVBQUU7QUFDQSxjQUFVLFVBQVU7QUFBQSxFQUN0QjtBQUNGO0FBRU8sU0FBUyxvQkFDZCxPQUNBLFVBQ0EsV0FDTTtBQUNOLE1BQUksSUFBSSxJQUFJLE1BQU0sSUFBSSxDQUFDLFNBQVMsS0FBSyxJQUFJLENBQUMsRUFBRSxTQUFTLE1BQU0sT0FBUSxPQUFNLElBQUksTUFBTSwrQkFBK0I7QUFDbEgsUUFBTSxRQUFRLENBQUMsU0FBc0I7QUFDbkMsZUFBVyxLQUFLLElBQUk7QUFDcEIsUUFBSSxLQUFLLGFBQWEsU0FBWSxXQUFXLEtBQUssSUFBSSxJQUFJLENBQUMsWUFBWSxLQUFLLE1BQU0sS0FBSyxRQUFRO0FBQzdGLFlBQU0sSUFBSSxNQUFNLEdBQUcsS0FBSyxJQUFJLGtGQUFrRjtBQUFBLEVBQ2xIO0FBQ0EsYUFBVyxRQUFRLE1BQU8sT0FBTSxJQUFJO0FBQ3BDLFFBQU0sU0FBcUQsQ0FBQyxHQUMxRCxZQUFzQixDQUFDLEdBQ3ZCLFNBQW9CLENBQUM7QUFDdkIsTUFBSTtBQUNGLGVBQVcsUUFBUSxNQUFPLFFBQU8sS0FBSyxFQUFFLE1BQU0sT0FBTyxVQUFVLEtBQUssTUFBTSxLQUFLLFVBQVUsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUNyRyxlQUFXLEVBQUUsTUFBTSxNQUFNLEtBQUssUUFBUTtBQUNwQyxVQUFJLEtBQUssYUFBYSxRQUFXO0FBQy9CLGNBQU0sSUFBSTtBQUNWLGlCQUFTLE1BQU0sV0FBVyxLQUFLLElBQUk7QUFBQSxNQUNyQztBQUNFLGNBQU0sUUFBUSxNQUFNO0FBQ2xCLGdCQUFNLElBQUk7QUFBQSxRQUNaLENBQUM7QUFDSCxnQkFBVSxLQUFLLEtBQUssSUFBSTtBQUN4QixrQkFBWSxLQUFLLElBQUk7QUFBQSxJQUN2QjtBQUFBLEVBQ0YsU0FBUyxPQUFPO0FBQ2QsV0FBTyxLQUFLLEtBQUs7QUFBQSxFQUNuQjtBQUNBLGFBQVcsRUFBRSxNQUFNLEtBQUs7QUFDdEIsUUFBSTtBQUNGLFlBQU0sUUFBUTtBQUFBLElBQ2hCLFNBQVMsT0FBTztBQUNkLGFBQU8sS0FBSyxLQUFLO0FBQUEsSUFDbkI7QUFDRixNQUFJLE9BQU8sV0FBVyxLQUFLLFVBQVUsV0FBVyxFQUFHLE9BQU0sVUFBVSxPQUFPLENBQUMsQ0FBQztBQUM1RSxNQUFJLE9BQU87QUFDVCxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQSxHQUFHLFVBQVUsT0FBTyxDQUFDLENBQUMsRUFBRSxPQUFPLHNCQUFzQixVQUFVLEtBQUssSUFBSSxLQUFLLE1BQU07QUFBQSxNQUNuRjtBQUFBLFFBQ0UsT0FBTyxPQUFPLENBQUM7QUFBQSxNQUNqQjtBQUFBLElBQ0Y7QUFDSjsiLCJuYW1lcyI6W10sImZpbGUiOiJhcHAvc3JjL2NvcmUvcnVudGltZS9maWxlLXB1YmxpY2F0aW9uLm1qcyJ9
