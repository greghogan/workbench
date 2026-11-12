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
    writeFileSync(descriptor, contents);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGUtcHVibGljYXRpb24ubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZmNobW9kU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgbGlua1N5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIGZzdGF0U3luYyxcbiAgcmVhZFN5bmMsXG4gIGNvbnN0YW50cyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4uL2RpYWdub3N0aWNzL2RpYWdub3N0aWMtZXJyb3JzLm1qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0YWdlZEZpbGUge1xuICByZWFkb25seSB0ZW1wb3Jhcnk6IHN0cmluZztcbiAgcmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuICBwdWJsaXNoKGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkKTogdm9pZDtcbiAgZGlzY2FyZCgpOiB2b2lkO1xufVxuZXhwb3J0IGludGVyZmFjZSBQdWJsaWNhdGlvbk9wdGlvbnMge1xuICBjcmVhdGVQYXJlbnQ/OiBib29sZWFuO1xufVxuZXhwb3J0IGNvbnN0IHB1YmxpY2F0aW9uVGVtcG9yYXJ5R2xvYiA9IFwiLiouPz8/Pz8/Pz8tPz8/Py0/Pz8/LT8/Pz8tPz8/Pz8/Pz8/Pz8/LnRtcFwiO1xuY29uc3QgcmV0cnlXYWl0ID0gbmV3IEludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKDQpKTtcblxuLyoqIFdpbmRvd3MgcmVhZGVycyBhbmQgc2Nhbm5lcnMgY2FuIHRlbXBvcmFyaWx5IGRlbnkgcmVwbGFjZW1lbnQ7IG5ldmVyIHVubGluayB0aGUgZGVzdGluYXRpb24uICovXG5mdW5jdGlvbiByZXBsYWNlRmlsZSh0ZW1wb3Jhcnk6IHN0cmluZywgcGF0aDogc3RyaW5nLCBiZWZvcmVSZXBsYWNlPzogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBjb25zdCBhdHRlbXB0cyA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IDggOiAxO1xuICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBhdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgLy8gQSBjb25mbGljdGluZyBlZGl0IGR1cmluZyBhIHNoYXJpbmcgdmlvbGF0aW9uIG11c3Qgc3RpbGwgcHJldmVudCBwdWJsaWNhdGlvbi5cbiAgICBiZWZvcmVSZXBsYWNlPy4oKTtcbiAgICB0cnkge1xuICAgICAgcmVuYW1lU3luYyh0ZW1wb3JhcnksIHBhdGgpO1xuICAgICAgcmV0dXJuO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBjb2RlID0gKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIgfHwgKGNvZGUgIT09IFwiRUFDQ0VTXCIgJiYgY29kZSAhPT0gXCJFUEVSTVwiICYmIGNvZGUgIT09IFwiRUJVU1lcIikpIHRocm93IGVycm9yO1xuICAgICAgaWYgKGF0dGVtcHQgPT09IGF0dGVtcHRzKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEF0b21pYyByZXBsYWNlbWVudCBmYWlsZWQgYWZ0ZXIgJHtTdHJpbmcoYXR0ZW1wdCl9IGF0dGVtcHRzOiAke3BhdGh9YCwgeyBjYXVzZTogZXJyb3IgfSk7XG4gICAgICBBdG9taWNzLndhaXQocmV0cnlXYWl0LCAwLCAwLCBNYXRoLm1pbigyNSAqIDIgKiogKGF0dGVtcHQgLSAxKSwgMjAwKSk7XG4gICAgfVxuICB9XG59XG5cbi8qKiBJZGVudGlmeSBvbmx5IHRoZSBVVUlEIGNhbmRpZGF0ZSBuYW1lcyBvd25lZCBieSB0aGlzIHB1Ymxpc2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwdWJsaWNhdGlvblRhcmdldChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBtYXRjaCA9IC9eXFwuKC4rKVxcLlthLWYwLTldezh9LVthLWYwLTldezR9LVthLWYwLTldezR9LVthLWYwLTldezR9LVthLWYwLTldezEyfVxcLnRtcCQvLmV4ZWMoYmFzZW5hbWUocGF0aCkpO1xuICByZXR1cm4gbWF0Y2g/LlsxXSA/IGpvaW4oZGlybmFtZShwYXRoKSwgbWF0Y2hbMV0pIDogdW5kZWZpbmVkO1xufVxuLyoqIEZpbmlzaCB3cml0aW5nIGFuZCBjbG9zaW5nIGV2ZXJ5IGNhbmRpZGF0ZSBiZWZvcmUgcHVibGlzaGluZyBhIGJhdGNoLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YWdlRmlsZShcbiAgcGF0aDogc3RyaW5nLFxuICBjb250ZW50czogc3RyaW5nIHwgVWludDhBcnJheSxcbiAgbW9kZT86IG51bWJlcixcbiAgb3B0aW9uczogUHVibGljYXRpb25PcHRpb25zID0ge30sXG4pOiBTdGFnZWRGaWxlIHtcbiAgaWYgKG9wdGlvbnMuY3JlYXRlUGFyZW50ICE9PSBmYWxzZSkgbWtkaXJTeW5jKGRpcm5hbWUocGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCB0ZW1wb3JhcnkgPSBqb2luKGRpcm5hbWUocGF0aCksIGAuJHtiYXNlbmFtZShwYXRoKX0uJHtyYW5kb21VVUlEKCl9LnRtcGApO1xuICBsZXQgZGVzY3JpcHRvcjogbnVtYmVyIHwgdW5kZWZpbmVkID0gb3BlblN5bmModGVtcG9yYXJ5LCBcInd4XCIsIG1vZGUpO1xuICBjb25zdCBzdGFnZWQ6IFN0YWdlZEZpbGUgPSB7XG4gICAgcGF0aCxcbiAgICB0ZW1wb3JhcnksXG4gICAgcHVibGlzaChiZWZvcmVSZXBsYWNlKSB7XG4gICAgICByZXBsYWNlRmlsZSh0ZW1wb3JhcnksIHBhdGgsIGJlZm9yZVJlcGxhY2UpO1xuICAgIH0sXG4gICAgZGlzY2FyZCgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHVubGlua1N5bmModGVtcG9yYXJ5KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlICE9PSBcIkVOT0VOVFwiKSB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoZGVzY3JpcHRvciwgY29udGVudHMpO1xuICAgIGlmIChtb2RlICE9PSB1bmRlZmluZWQpIGZjaG1vZFN5bmMoZGVzY3JpcHRvciwgbW9kZSk7XG4gICAgY29uc3Qgd3JpdHRlbiA9IGRlc2NyaXB0b3I7XG4gICAgZGVzY3JpcHRvciA9IHVuZGVmaW5lZDsgLy8gQSBmYWlsZWQgY2xvc2UgbWF5IGhhdmUgcmVsZWFzZWQgaXRzIGRlc2NyaXB0b3IgYWxyZWFkeS5cbiAgICBjbG9zZVN5bmMod3JpdHRlbik7XG4gICAgcmV0dXJuIHN0YWdlZDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zdCBmYWlsdXJlczogdW5rbm93bltdID0gW107XG4gICAgaWYgKGRlc2NyaXB0b3IgIT09IHVuZGVmaW5lZClcbiAgICAgIHRyeSB7XG4gICAgICAgIGNsb3NlU3luYyhkZXNjcmlwdG9yKTtcbiAgICAgIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICAgICAgZmFpbHVyZXMucHVzaChjbGVhbnVwKTtcbiAgICAgIH1cbiAgICB0cnkge1xuICAgICAgc3RhZ2VkLmRpc2NhcmQoKTtcbiAgICB9IGNhdGNoIChjbGVhbnVwKSB7XG4gICAgICBmYWlsdXJlcy5wdXNoKGNsZWFudXApO1xuICAgIH1cbiAgICBpZiAoZmFpbHVyZXMubGVuZ3RoKVxuICAgICAgdGhyb3cgY29tYmluZUZhaWx1cmVzKFxuICAgICAgICBlcnJvcixcbiAgICAgICAgbmV3IEFnZ3JlZ2F0ZUVycm9yKGZhaWx1cmVzLCBgVGVtcG9yYXJ5IGZpbGUgY2xlYW51cCBmYWlsZWQ6ICR7dGVtcG9yYXJ5fWApLFxuICAgICAgICBcIkZpbGUgcHJlcGFyYXRpb24gYW5kIGNsZWFudXAgZmFpbGVkXCIsXG4gICAgICApO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5mdW5jdGlvbiBwdWJsaXNoKHN0YWdlZDogU3RhZ2VkRmlsZSwgYWN0aW9uOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIGxldCBmYWlsdXJlOiB1bmtub3duO1xuICBsZXQgZmFpbGVkID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgYWN0aW9uKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbGVkID0gdHJ1ZTtcbiAgICBmYWlsdXJlID0gZXJyb3I7XG4gIH1cbiAgdHJ5IHtcbiAgICBzdGFnZWQuZGlzY2FyZCgpO1xuICB9IGNhdGNoIChjbGVhbnVwKSB7XG4gICAgaWYgKGZhaWxlZCkgdGhyb3cgY29tYmluZUZhaWx1cmVzKGZhaWx1cmUsIGNsZWFudXAsIGBGaWxlIHB1YmxpY2F0aW9uIGFuZCBjbGVhbnVwIGZhaWxlZDogJHtzdGFnZWQudGVtcG9yYXJ5fWApO1xuICAgIHRocm93IGNsZWFudXA7XG4gIH1cbiAgaWYgKGZhaWxlZCkgdGhyb3cgZXJyb3JGcm9tKGZhaWx1cmUpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlQXRvbWljKFxuICBwYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LFxuICBtb2RlPzogbnVtYmVyLFxuICBiZWZvcmVSZXBsYWNlPzogKCkgPT4gdm9pZCxcbiAgb3B0aW9uczogUHVibGljYXRpb25PcHRpb25zID0ge30sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhZ2VkID0gc3RhZ2VGaWxlKHBhdGgsIGNvbnRlbnRzLCBtb2RlLCBvcHRpb25zKTtcbiAgcHVibGlzaChzdGFnZWQsICgpID0+IHtcbiAgICBzdGFnZWQucHVibGlzaChiZWZvcmVSZXBsYWNlKTtcbiAgfSk7XG59XG4vKiogUHVibGlzaCBhIGNvbXBsZXRlbHkgd3JpdHRlbiBuZXcgZmlsZSB3aXRob3V0IHJlcGxhY2luZyBhbiBleGlzdGluZyBkZXN0aW5hdGlvbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZU5ldyhwYXRoOiBzdHJpbmcsIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LCBtb2RlPzogbnVtYmVyKTogdm9pZCB7XG4gIGNvbnN0IHN0YWdlZCA9IHN0YWdlRmlsZShwYXRoLCBjb250ZW50cywgbW9kZSk7XG4gIHB1Ymxpc2goc3RhZ2VkLCAoKSA9PiB7XG4gICAgbGlua1N5bmMoc3RhZ2VkLnRlbXBvcmFyeSwgcGF0aCk7XG4gIH0pO1xufVxuLyoqIEV4cGVjdGVkIGJ5dGVzIGFyZSBjaGVja2VkIGF0IHRoZSBmaW5hbCByZXBsYWNlbWVudCBib3VuZGFyeS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwdWJsaXNoRmlsZShcbiAgcGF0aDogc3RyaW5nLFxuICBjb250ZW50czogc3RyaW5nIHwgVWludDhBcnJheSxcbiAgZXhwZWN0ZWQ6IFVpbnQ4QXJyYXkgfCB1bmRlZmluZWQsXG4gIG1vZGU/OiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgcHVibGlzaENoZWNrZWRGaWxlcyhbeyBwYXRoLCBjb250ZW50cywgZXhwZWN0ZWQsIC4uLihtb2RlID09PSB1bmRlZmluZWQgPyB7fSA6IHsgbW9kZSB9KSB9XSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2hlY2tlZEZpbGUge1xuICBwYXRoOiBzdHJpbmc7XG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5O1xuICBleHBlY3RlZDogVWludDhBcnJheSB8IHVuZGVmaW5lZDtcbiAgbW9kZT86IG51bWJlcjtcbn1cbmZ1bmN0aW9uIG1hdGNoZXNGaWxlKHBhdGg6IHN0cmluZywgZXhwZWN0ZWQ6IFVpbnQ4QXJyYXkpOiBib29sZWFuIHtcbiAgbGV0IGRlc2NyaXB0b3I6IG51bWJlcjtcbiAgdHJ5IHtcbiAgICBkZXNjcmlwdG9yID0gb3BlblN5bmMoXG4gICAgICBwYXRoLFxuICAgICAgY29uc3RhbnRzLk9fUkRPTkxZIHwgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IDAgOiBjb25zdGFudHMuT19OT0ZPTExPVyB8IGNvbnN0YW50cy5PX05PTkJMT0NLKSxcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChbXCJFTk9FTlRcIiwgXCJFTE9PUFwiXS5pbmNsdWRlcygoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID8/IFwiXCIpKSByZXR1cm4gZmFsc2U7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBiZWZvcmUgPSBmc3RhdFN5bmMoZGVzY3JpcHRvcik7XG4gICAgaWYgKCFiZWZvcmUuaXNGaWxlKCkgfHwgYmVmb3JlLnNpemUgIT09IGV4cGVjdGVkLmJ5dGVMZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBidWZmZXIgPSBCdWZmZXIuYWxsb2MoTWF0aC5taW4oNjQgKiAxMDI0LCBleHBlY3RlZC5ieXRlTGVuZ3RoICsgMSkpO1xuICAgIGxldCBvZmZzZXQgPSAwO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IGNvdW50ID0gcmVhZFN5bmMoZGVzY3JpcHRvciwgYnVmZmVyLCAwLCBidWZmZXIubGVuZ3RoLCBudWxsKTtcbiAgICAgIGlmICghY291bnQpIGJyZWFrO1xuICAgICAgaWYgKFxuICAgICAgICBvZmZzZXQgKyBjb3VudCA+IGV4cGVjdGVkLmJ5dGVMZW5ndGggfHxcbiAgICAgICAgIWJ1ZmZlci5zdWJhcnJheSgwLCBjb3VudCkuZXF1YWxzKGV4cGVjdGVkLnN1YmFycmF5KG9mZnNldCwgb2Zmc2V0ICsgY291bnQpKVxuICAgICAgKVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICBvZmZzZXQgKz0gY291bnQ7XG4gICAgfVxuICAgIGNvbnN0IGFmdGVyID0gZnN0YXRTeW5jKGRlc2NyaXB0b3IpO1xuICAgIHJldHVybiAoXG4gICAgICBvZmZzZXQgPT09IGV4cGVjdGVkLmJ5dGVMZW5ndGggJiZcbiAgICAgIGJlZm9yZS5zaXplID09PSBhZnRlci5zaXplICYmXG4gICAgICBiZWZvcmUubXRpbWVNcyA9PT0gYWZ0ZXIubXRpbWVNcyAmJlxuICAgICAgYmVmb3JlLmN0aW1lTXMgPT09IGFmdGVyLmN0aW1lTXNcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlU3luYyhkZXNjcmlwdG9yKTtcbiAgfVxufVxuLyoqIFByZWZsaWdodCB0aGUgZnVsbCBiYXRjaCwgdGhlbiByZWNoZWNrIGVhY2ggZmlsZSBhdCBpdHMgZmluYWwgcHVibGljYXRpb24gYm91bmRhcnkuICovXG5leHBvcnQgZnVuY3Rpb24gcHVibGlzaENoZWNrZWRGaWxlcyhcbiAgZmlsZXM6IHJlYWRvbmx5IENoZWNrZWRGaWxlW10sXG4gIHZhbGlkYXRlPzogKHBhdGg6IHN0cmluZykgPT4gdm9pZCxcbiAgcHVibGlzaGVkPzogKHBhdGg6IHN0cmluZykgPT4gdm9pZCxcbik6IHZvaWQge1xuICBpZiAobmV3IFNldChmaWxlcy5tYXAoKGZpbGUpID0+IGZpbGUucGF0aCkpLnNpemUgIT09IGZpbGVzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiRHVwbGljYXRlIGNoZWNrZWQgb3V0cHV0IHBhdGhcIik7XG4gIGNvbnN0IGNoZWNrID0gKGZpbGU6IENoZWNrZWRGaWxlKSA9PiB7XG4gICAgdmFsaWRhdGU/LihmaWxlLnBhdGgpO1xuICAgIGlmIChmaWxlLmV4cGVjdGVkID09PSB1bmRlZmluZWQgPyBleGlzdHNTeW5jKGZpbGUucGF0aCkgOiAhbWF0Y2hlc0ZpbGUoZmlsZS5wYXRoLCBmaWxlLmV4cGVjdGVkKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtmaWxlLnBhdGh9OiBmaWxlIGNoYW5nZWQgYmVmb3JlIHJlcGxhY2VtZW50OyBwcmVzZXJ2ZSB0aGUgY2hhbmdlcyBhbmQgaW5zcGVjdCBhIGZyZXNoIHBsYW5gKTtcbiAgfTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSBjaGVjayhmaWxlKTtcbiAgY29uc3Qgc3RhZ2VkOiB7IGZpbGU6IENoZWNrZWRGaWxlOyBzdGFnZTogU3RhZ2VkRmlsZSB9W10gPSBbXSxcbiAgICBjb21wbGV0ZWQ6IHN0cmluZ1tdID0gW10sXG4gICAgZXJyb3JzOiB1bmtub3duW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHN0YWdlZC5wdXNoKHsgZmlsZSwgc3RhZ2U6IHN0YWdlRmlsZShmaWxlLnBhdGgsIGZpbGUuY29udGVudHMsIGZpbGUubW9kZSkgfSk7XG4gICAgZm9yIChjb25zdCB7IGZpbGUsIHN0YWdlIH0gb2Ygc3RhZ2VkKSB7XG4gICAgICBpZiAoZmlsZS5leHBlY3RlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNoZWNrKGZpbGUpO1xuICAgICAgICBsaW5rU3luYyhzdGFnZS50ZW1wb3JhcnksIGZpbGUucGF0aCk7XG4gICAgICB9IGVsc2VcbiAgICAgICAgc3RhZ2UucHVibGlzaCgoKSA9PiB7XG4gICAgICAgICAgY2hlY2soZmlsZSk7XG4gICAgICAgIH0pO1xuICAgICAgY29tcGxldGVkLnB1c2goZmlsZS5wYXRoKTtcbiAgICAgIHB1Ymxpc2hlZD8uKGZpbGUucGF0aCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGVycm9ycy5wdXNoKGVycm9yKTtcbiAgfVxuICBmb3IgKGNvbnN0IHsgc3RhZ2UgfSBvZiBzdGFnZWQpXG4gICAgdHJ5IHtcbiAgICAgIHN0YWdlLmRpc2NhcmQoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgZXJyb3JzLnB1c2goZXJyb3IpO1xuICAgIH1cbiAgaWYgKGVycm9ycy5sZW5ndGggPT09IDEgJiYgY29tcGxldGVkLmxlbmd0aCA9PT0gMCkgdGhyb3cgZXJyb3JGcm9tKGVycm9yc1swXSk7XG4gIGlmIChlcnJvcnMubGVuZ3RoKVxuICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihcbiAgICAgIGVycm9ycyxcbiAgICAgIGAke2Vycm9yRnJvbShlcnJvcnNbMF0pLm1lc3NhZ2V9OyBwdWJsaXNoZWQgZmlsZXM6ICR7Y29tcGxldGVkLmpvaW4oXCIsIFwiKSB8fCBcIm5vbmVcIn1gLFxuICAgICAge1xuICAgICAgICBjYXVzZTogZXJyb3JzWzBdLFxuICAgICAgfSxcbiAgICApO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxrQkFBa0I7QUFDM0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxVQUFVLFNBQVMsWUFBWTtBQUN4QyxTQUFTLHVCQUF1QjtBQVd6QixNQUFNLDJCQUEyQjtBQUN4QyxNQUFNLFlBQVksSUFBSSxXQUFXLElBQUksa0JBQWtCLENBQUMsQ0FBQztBQUd6RCxTQUFTLFlBQVksV0FBbUIsTUFBYyxlQUFrQztBQUN0RixRQUFNLFdBQVcsUUFBUSxhQUFhLFVBQVUsSUFBSTtBQUNwRCxXQUFTLFVBQVUsR0FBRyxXQUFXLFVBQVUsV0FBVztBQUVwRCxvQkFBZ0I7QUFDaEIsUUFBSTtBQUNGLGlCQUFXLFdBQVcsSUFBSTtBQUMxQjtBQUFBLElBQ0YsU0FBUyxPQUFPO0FBQ2QsWUFBTSxPQUFRLE1BQWdDO0FBQzlDLFVBQUksUUFBUSxhQUFhLFdBQVksU0FBUyxZQUFZLFNBQVMsV0FBVyxTQUFTLFFBQVUsT0FBTTtBQUN2RyxVQUFJLFlBQVk7QUFDZCxjQUFNLElBQUksTUFBTSxtQ0FBbUMsT0FBTyxPQUFPLENBQUMsY0FBYyxJQUFJLElBQUksRUFBRSxPQUFPLE1BQU0sQ0FBQztBQUMxRyxjQUFRLEtBQUssV0FBVyxHQUFHLEdBQUcsS0FBSyxJQUFJLEtB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QkFBK0I7QUFDbEgsUUFBTSxRQUFRLENBQUMsU0FBc0I7QUFDbkMsZUFBVyxLQUFLLElBQUk7QUFDcEIsUUFBSSxLQUFLLGFBQWEsU0FBWSxXQUFXLEtBQUssSUFBSSxJQUFJLENBQUMsWUFBWSxLQUFLLE1BQU0sS0FBSyxRQUFRO0FBQzdGLFlBQU0sSUFBSSxNQUFNLEdBQUcsS0FBSyxJQUFJLGtGQUFrRjtBQUFBLEVBQ2xIO0FBQ0EsYUFBVyxRQUFRLE1BQU8sT0FBTSxJQUFJO0FBQ3BDLFFBQU0sU0FBcUQsQ0FBQyxHQUMxRCxZQUFzQixDQUFDLEdBQ3ZCLFNBQW9CLENBQUM7QUFDdkIsTUFBSTtBQUNGLGVBQVcsUUFBUSxNQUFPLFFBQU8sS0FBSyxFQUFFLE1BQU0sT0FBTyxVQUFVLEtBQUssTUFBTSxLQUFLLFVBQVUsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUNyRyxlQUFXLEVBQUUsTUFBTSxNQUFNLEtBQUssUUFBUTtBQUNwQyxVQUFJLEtBQUssYUFBYSxRQUFXO0FBQy9CLGNBQU0sSUFBSTtBQUNWLGlCQUFTLE1BQU0sV0FBVyxLQUFLLElBQUk7QUFBQSxNQUNyQztBQUNFLGNBQU0sUUFBUSxNQUFNO0FBQ2xCLGdCQUFNLElBQUk7QUFBQSxRQUNaLENBQUM7QUFDSCxnQkFBVSxLQUFLLEtBQUssSUFBSTtBQUN4QixrQkFBWSxLQUFLLElBQUk7QUFBQSxJQUN2QjtBQUFBLEVBQ0YsU0FBUyxPQUFPO0FBQ2QsV0FBTyxLQUFLLEtBQUs7QUFBQSxFQUNuQjtBQUNBLGFBQVcsRUFBRSxNQUFNLEtBQUs7QUFDdEIsUUFBSTtBQUNGLFlBQU0sUUFBUTtBQUFBLElBQ2hCLFNBQVMsT0FBTztBQUNkLGFBQU8sS0FBSyxLQUFLO0FBQUEsSUFDbkI7QUFDRixNQUFJLE9BQU8sV0FBVyxLQUFLLFVBQVUsV0FBVyxFQUFHLE9BQU0sVUFBVSxPQUFPLENBQUMsQ0FBQztBQUM1RSxNQUFJLE9BQU87QUFDVCxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQSxHQUFHLFVBQVUsT0FBTyxDQUFDLENBQUMsRUFBRSxPQUFPLHNCQUFzQixVQUFVLEtBQUssSUFBSSxLQUFLLE1BQU07QUFBQSxNQUNuRjtBQUFBLFFBQ0UsT0FBTyxPQUFPLENBQUM7QUFBQSxNQUNqQjtBQUFBLElBQ0Y7QUFDSjsiLCJuYW1lcyI6W10sImZpbGUiOiJhcHAvc3JjL2NvcmUvcnVudGltZS9maWxlLXB1YmxpY2F0aW9uLm1qcyJ9
