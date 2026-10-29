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
import { combineFailures } from "./diagnostic-errors.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGUtcHVibGljYXRpb24ubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZmNobW9kU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgbGlua1N5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIGZzdGF0U3luYyxcbiAgcmVhZFN5bmMsXG4gIGNvbnN0YW50cyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4vZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhZ2VkRmlsZSB7XG4gIHJlYWRvbmx5IHRlbXBvcmFyeTogc3RyaW5nO1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIHB1Ymxpc2goYmVmb3JlUmVwbGFjZT86ICgpID0+IHZvaWQpOiB2b2lkO1xuICBkaXNjYXJkKCk6IHZvaWQ7XG59XG5leHBvcnQgaW50ZXJmYWNlIFB1YmxpY2F0aW9uT3B0aW9ucyB7XG4gIGNyZWF0ZVBhcmVudD86IGJvb2xlYW47XG59XG5leHBvcnQgY29uc3QgcHVibGljYXRpb25UZW1wb3JhcnlHbG9iID0gXCIuKi4/Pz8/Pz8/Py0/Pz8/LT8/Pz8tPz8/Py0/Pz8/Pz8/Pz8/Pz8udG1wXCI7XG5jb25zdCByZXRyeVdhaXQgPSBuZXcgSW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoNCkpO1xuXG4vKiogV2luZG93cyByZWFkZXJzIGFuZCBzY2FubmVycyBjYW4gdGVtcG9yYXJpbHkgZGVueSByZXBsYWNlbWVudDsgbmV2ZXIgdW5saW5rIHRoZSBkZXN0aW5hdGlvbi4gKi9cbmZ1bmN0aW9uIHJlcGxhY2VGaWxlKHRlbXBvcmFyeTogc3RyaW5nLCBwYXRoOiBzdHJpbmcsIGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIGNvbnN0IGF0dGVtcHRzID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gOCA6IDE7XG4gIGZvciAobGV0IGF0dGVtcHQgPSAxOyBhdHRlbXB0IDw9IGF0dGVtcHRzOyBhdHRlbXB0KyspIHtcbiAgICAvLyBBIGNvbmZsaWN0aW5nIGVkaXQgZHVyaW5nIGEgc2hhcmluZyB2aW9sYXRpb24gbXVzdCBzdGlsbCBwcmV2ZW50IHB1YmxpY2F0aW9uLlxuICAgIGJlZm9yZVJlcGxhY2U/LigpO1xuICAgIHRyeSB7XG4gICAgICByZW5hbWVTeW5jKHRlbXBvcmFyeSwgcGF0aCk7XG4gICAgICByZXR1cm47XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIiB8fCAoY29kZSAhPT0gXCJFQUNDRVNcIiAmJiBjb2RlICE9PSBcIkVQRVJNXCIgJiYgY29kZSAhPT0gXCJFQlVTWVwiKSkgdGhyb3cgZXJyb3I7XG4gICAgICBpZiAoYXR0ZW1wdCA9PT0gYXR0ZW1wdHMpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXRvbWljIHJlcGxhY2VtZW50IGZhaWxlZCBhZnRlciAke1N0cmluZyhhdHRlbXB0KX0gYXR0ZW1wdHM6ICR7cGF0aH1gLCB7IGNhdXNlOiBlcnJvciB9KTtcbiAgICAgIEF0b21pY3Mud2FpdChyZXRyeVdhaXQsIDAsIDAsIE1hdGgubWluKDI1ICogMiAqKiAoYXR0ZW1wdCAtIDEpLCAyMDApKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIElkZW50aWZ5IG9ubHkgdGhlIFVVSUQgY2FuZGlkYXRlIG5hbWVzIG93bmVkIGJ5IHRoaXMgcHVibGlzaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1YmxpY2F0aW9uVGFyZ2V0KHBhdGg6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IG1hdGNoID0gL15cXC4oLispXFwuW2EtZjAtOV17OH0tW2EtZjAtOV17NH0tW2EtZjAtOV17NH0tW2EtZjAtOV17NH0tW2EtZjAtOV17MTJ9XFwudG1wJC8uZXhlYyhiYXNlbmFtZShwYXRoKSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8gam9pbihkaXJuYW1lKHBhdGgpLCBtYXRjaFsxXSkgOiB1bmRlZmluZWQ7XG59XG4vKiogRmluaXNoIHdyaXRpbmcgYW5kIGNsb3NpbmcgZXZlcnkgY2FuZGlkYXRlIGJlZm9yZSBwdWJsaXNoaW5nIGEgYmF0Y2guICovXG5leHBvcnQgZnVuY3Rpb24gc3RhZ2VGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LFxuICBtb2RlPzogbnVtYmVyLFxuICBvcHRpb25zOiBQdWJsaWNhdGlvbk9wdGlvbnMgPSB7fSxcbik6IFN0YWdlZEZpbGUge1xuICBpZiAob3B0aW9ucy5jcmVhdGVQYXJlbnQgIT09IGZhbHNlKSBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IGpvaW4oZGlybmFtZShwYXRoKSwgYC4ke2Jhc2VuYW1lKHBhdGgpfS4ke3JhbmRvbVVVSUQoKX0udG1wYCk7XG4gIGxldCBkZXNjcmlwdG9yOiBudW1iZXIgfCB1bmRlZmluZWQgPSBvcGVuU3luYyh0ZW1wb3JhcnksIFwid3hcIiwgbW9kZSk7XG4gIGNvbnN0IHN0YWdlZDogU3RhZ2VkRmlsZSA9IHtcbiAgICBwYXRoLFxuICAgIHRlbXBvcmFyeSxcbiAgICBwdWJsaXNoKGJlZm9yZVJlcGxhY2UpIHtcbiAgICAgIHJlcGxhY2VGaWxlKHRlbXBvcmFyeSwgcGF0aCwgYmVmb3JlUmVwbGFjZSk7XG4gICAgfSxcbiAgICBkaXNjYXJkKCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdW5saW5rU3luYyh0ZW1wb3JhcnkpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRU5PRU5UXCIpIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhkZXNjcmlwdG9yLCBjb250ZW50cyk7XG4gICAgaWYgKG1vZGUgIT09IHVuZGVmaW5lZCkgZmNobW9kU3luYyhkZXNjcmlwdG9yLCBtb2RlKTtcbiAgICBjb25zdCB3cml0dGVuID0gZGVzY3JpcHRvcjtcbiAgICBkZXNjcmlwdG9yID0gdW5kZWZpbmVkOyAvLyBBIGZhaWxlZCBjbG9zZSBtYXkgaGF2ZSByZWxlYXNlZCBpdHMgZGVzY3JpcHRvciBhbHJlYWR5LlxuICAgIGNsb3NlU3luYyh3cml0dGVuKTtcbiAgICByZXR1cm4gc3RhZ2VkO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IGZhaWx1cmVzOiB1bmtub3duW10gPSBbXTtcbiAgICBpZiAoZGVzY3JpcHRvciAhPT0gdW5kZWZpbmVkKVxuICAgICAgdHJ5IHtcbiAgICAgICAgY2xvc2VTeW5jKGRlc2NyaXB0b3IpO1xuICAgICAgfSBjYXRjaCAoY2xlYW51cCkge1xuICAgICAgICBmYWlsdXJlcy5wdXNoKGNsZWFudXApO1xuICAgICAgfVxuICAgIHRyeSB7XG4gICAgICBzdGFnZWQuZGlzY2FyZCgpO1xuICAgIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goY2xlYW51cCk7XG4gICAgfVxuICAgIGlmIChmYWlsdXJlcy5sZW5ndGgpXG4gICAgICB0aHJvdyBjb21iaW5lRmFpbHVyZXMoXG4gICAgICAgIGVycm9yLFxuICAgICAgICBuZXcgQWdncmVnYXRlRXJyb3IoZmFpbHVyZXMsIGBUZW1wb3JhcnkgZmlsZSBjbGVhbnVwIGZhaWxlZDogJHt0ZW1wb3Jhcnl9YCksXG4gICAgICAgIFwiRmlsZSBwcmVwYXJhdGlvbiBhbmQgY2xlYW51cCBmYWlsZWRcIixcbiAgICAgICk7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cbmZ1bmN0aW9uIHB1Ymxpc2goc3RhZ2VkOiBTdGFnZWRGaWxlLCBhY3Rpb246ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgbGV0IGZhaWx1cmU6IHVua25vd247XG4gIGxldCBmYWlsZWQgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBhY3Rpb24oKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsZWQgPSB0cnVlO1xuICAgIGZhaWx1cmUgPSBlcnJvcjtcbiAgfVxuICB0cnkge1xuICAgIHN0YWdlZC5kaXNjYXJkKCk7XG4gIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICBpZiAoZmFpbGVkKSB0aHJvdyBjb21iaW5lRmFpbHVyZXMoZmFpbHVyZSwgY2xlYW51cCwgYEZpbGUgcHVibGljYXRpb24gYW5kIGNsZWFudXAgZmFpbGVkOiAke3N0YWdlZC50ZW1wb3Jhcnl9YCk7XG4gICAgdGhyb3cgY2xlYW51cDtcbiAgfVxuICBpZiAoZmFpbGVkKSB0aHJvdyBlcnJvckZyb20oZmFpbHVyZSk7XG59XG5leHBvcnQgZnVuY3Rpb24gd3JpdGVBdG9taWMoXG4gIHBhdGg6IHN0cmluZyxcbiAgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXksXG4gIG1vZGU/OiBudW1iZXIsXG4gIGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkLFxuICBvcHRpb25zOiBQdWJsaWNhdGlvbk9wdGlvbnMgPSB7fSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFnZWQgPSBzdGFnZUZpbGUocGF0aCwgY29udGVudHMsIG1vZGUsIG9wdGlvbnMpO1xuICBwdWJsaXNoKHN0YWdlZCwgKCkgPT4ge1xuICAgIHN0YWdlZC5wdWJsaXNoKGJlZm9yZVJlcGxhY2UpO1xuICB9KTtcbn1cbi8qKiBQdWJsaXNoIGEgY29tcGxldGVseSB3cml0dGVuIG5ldyBmaWxlIHdpdGhvdXQgcmVwbGFjaW5nIGFuIGV4aXN0aW5nIGRlc3RpbmF0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlTmV3KHBhdGg6IHN0cmluZywgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXksIG1vZGU/OiBudW1iZXIpOiB2b2lkIHtcbiAgY29uc3Qgc3RhZ2VkID0gc3RhZ2VGaWxlKHBhdGgsIGNvbnRlbnRzLCBtb2RlKTtcbiAgcHVibGlzaChzdGFnZWQsICgpID0+IHtcbiAgICBsaW5rU3luYyhzdGFnZWQudGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSk7XG59XG4vKiogRXhwZWN0ZWQgYnl0ZXMgYXJlIGNoZWNrZWQgYXQgdGhlIGZpbmFsIHJlcGxhY2VtZW50IGJvdW5kYXJ5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1Ymxpc2hGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LFxuICBleHBlY3RlZDogVWludDhBcnJheSB8IHVuZGVmaW5lZCxcbiAgbW9kZT86IG51bWJlcixcbik6IHZvaWQge1xuICBwdWJsaXNoQ2hlY2tlZEZpbGVzKFt7IHBhdGgsIGNvbnRlbnRzLCBleHBlY3RlZCwgLi4uKG1vZGUgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBtb2RlIH0pIH1dKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDaGVja2VkRmlsZSB7XG4gIHBhdGg6IHN0cmluZztcbiAgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXk7XG4gIGV4cGVjdGVkOiBVaW50OEFycmF5IHwgdW5kZWZpbmVkO1xuICBtb2RlPzogbnVtYmVyO1xufVxuZnVuY3Rpb24gbWF0Y2hlc0ZpbGUocGF0aDogc3RyaW5nLCBleHBlY3RlZDogVWludDhBcnJheSk6IGJvb2xlYW4ge1xuICBsZXQgZGVzY3JpcHRvcjogbnVtYmVyO1xuICB0cnkge1xuICAgIGRlc2NyaXB0b3IgPSBvcGVuU3luYyhcbiAgICAgIHBhdGgsXG4gICAgICBjb25zdGFudHMuT19SRE9OTFkgfCAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gMCA6IGNvbnN0YW50cy5PX05PRk9MTE9XIHwgY29uc3RhbnRzLk9fTk9OQkxPQ0spLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKFtcIkVOT0VOVFwiLCBcIkVMT09QXCJdLmluY2x1ZGVzKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPz8gXCJcIikpIHJldHVybiBmYWxzZTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGJlZm9yZSA9IGZzdGF0U3luYyhkZXNjcmlwdG9yKTtcbiAgICBpZiAoIWJlZm9yZS5pc0ZpbGUoKSB8fCBiZWZvcmUuc2l6ZSAhPT0gZXhwZWN0ZWQuYnl0ZUxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGJ1ZmZlciA9IEJ1ZmZlci5hbGxvYyhNYXRoLm1pbig2NCAqIDEwMjQsIGV4cGVjdGVkLmJ5dGVMZW5ndGggKyAxKSk7XG4gICAgbGV0IG9mZnNldCA9IDA7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgY291bnQgPSByZWFkU3luYyhkZXNjcmlwdG9yLCBidWZmZXIsIDAsIGJ1ZmZlci5sZW5ndGgsIG51bGwpO1xuICAgICAgaWYgKCFjb3VudCkgYnJlYWs7XG4gICAgICBpZiAoXG4gICAgICAgIG9mZnNldCArIGNvdW50ID4gZXhwZWN0ZWQuYnl0ZUxlbmd0aCB8fFxuICAgICAgICAhYnVmZmVyLnN1YmFycmF5KDAsIGNvdW50KS5lcXVhbHMoZXhwZWN0ZWQuc3ViYXJyYXkob2Zmc2V0LCBvZmZzZXQgKyBjb3VudCkpXG4gICAgICApXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIG9mZnNldCArPSBjb3VudDtcbiAgICB9XG4gICAgY29uc3QgYWZ0ZXIgPSBmc3RhdFN5bmMoZGVzY3JpcHRvcik7XG4gICAgcmV0dXJuIChcbiAgICAgIG9mZnNldCA9PT0gZXhwZWN0ZWQuYnl0ZUxlbmd0aCAmJlxuICAgICAgYmVmb3JlLnNpemUgPT09IGFmdGVyLnNpemUgJiZcbiAgICAgIGJlZm9yZS5tdGltZU1zID09PSBhZnRlci5tdGltZU1zICYmXG4gICAgICBiZWZvcmUuY3RpbWVNcyA9PT0gYWZ0ZXIuY3RpbWVNc1xuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VTeW5jKGRlc2NyaXB0b3IpO1xuICB9XG59XG4vKiogUHJlZmxpZ2h0IHRoZSBmdWxsIGJhdGNoLCB0aGVuIHJlY2hlY2sgZWFjaCBmaWxlIGF0IGl0cyBmaW5hbCBwdWJsaWNhdGlvbiBib3VuZGFyeS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwdWJsaXNoQ2hlY2tlZEZpbGVzKFxuICBmaWxlczogcmVhZG9ubHkgQ2hlY2tlZEZpbGVbXSxcbiAgdmFsaWRhdGU/OiAocGF0aDogc3RyaW5nKSA9PiB2b2lkLFxuICBwdWJsaXNoZWQ/OiAocGF0aDogc3RyaW5nKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGlmIChuZXcgU2V0KGZpbGVzLm1hcCgoZmlsZSkgPT4gZmlsZS5wYXRoKSkuc2l6ZSAhPT0gZmlsZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJEdXBsaWNhdGUgY2hlY2tlZCBvdXRwdXQgcGF0aFwiKTtcbiAgY29uc3QgY2hlY2sgPSAoZmlsZTogQ2hlY2tlZEZpbGUpID0+IHtcbiAgICB2YWxpZGF0ZT8uKGZpbGUucGF0aCk7XG4gICAgaWYgKGZpbGUuZXhwZWN0ZWQgPT09IHVuZGVmaW5lZCA/IGV4aXN0c1N5bmMoZmlsZS5wYXRoKSA6ICFtYXRjaGVzRmlsZShmaWxlLnBhdGgsIGZpbGUuZXhwZWN0ZWQpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2ZpbGUucGF0aH06IGZpbGUgY2hhbmdlZCBiZWZvcmUgcmVwbGFjZW1lbnQ7IHByZXNlcnZlIHRoZSBjaGFuZ2VzIGFuZCBpbnNwZWN0IGEgZnJlc2ggcGxhbmApO1xuICB9O1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIGNoZWNrKGZpbGUpO1xuICBjb25zdCBzdGFnZWQ6IHsgZmlsZTogQ2hlY2tlZEZpbGU7IHN0YWdlOiBTdGFnZWRGaWxlIH1bXSA9IFtdLFxuICAgIGNvbXBsZXRlZDogc3RyaW5nW10gPSBbXSxcbiAgICBlcnJvcnM6IHVua25vd25bXSA9IFtdO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykgc3RhZ2VkLnB1c2goeyBmaWxlLCBzdGFnZTogc3RhZ2VGaWxlKGZpbGUucGF0aCwgZmlsZS5jb250ZW50cywgZmlsZS5tb2RlKSB9KTtcbiAgICBmb3IgKGNvbnN0IHsgZmlsZSwgc3RhZ2UgfSBvZiBzdGFnZWQpIHtcbiAgICAgIGlmIChmaWxlLmV4cGVjdGVkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY2hlY2soZmlsZSk7XG4gICAgICAgIGxpbmtTeW5jKHN0YWdlLnRlbXBvcmFyeSwgZmlsZS5wYXRoKTtcbiAgICAgIH0gZWxzZVxuICAgICAgICBzdGFnZS5wdWJsaXNoKCgpID0+IHtcbiAgICAgICAgICBjaGVjayhmaWxlKTtcbiAgICAgICAgfSk7XG4gICAgICBjb21wbGV0ZWQucHVzaChmaWxlLnBhdGgpO1xuICAgICAgcHVibGlzaGVkPy4oZmlsZS5wYXRoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZXJyb3JzLnB1c2goZXJyb3IpO1xuICB9XG4gIGZvciAoY29uc3QgeyBzdGFnZSB9IG9mIHN0YWdlZClcbiAgICB0cnkge1xuICAgICAgc3RhZ2UuZGlzY2FyZCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnJvcik7XG4gICAgfVxuICBpZiAoZXJyb3JzLmxlbmd0aCA9PT0gMSAmJiBjb21wbGV0ZWQubGVuZ3RoID09PSAwKSB0aHJvdyBlcnJvckZyb20oZXJyb3JzWzBdKTtcbiAgaWYgKGVycm9ycy5sZW5ndGgpXG4gICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKFxuICAgICAgZXJyb3JzLFxuICAgICAgYCR7ZXJyb3JGcm9tKGVycm9yc1swXSkubWVzc2FnZX07IHB1Ymxpc2hlZCBmaWxlczogJHtjb21wbGV0ZWQuam9pbihcIiwgXCIpIHx8IFwibm9uZVwifWAsXG4gICAgICB7XG4gICAgICAgIGNhdXNlOiBlcnJvcnNbMF0sXG4gICAgICB9LFxuICAgICk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLFVBQVUsU0FBUyxZQUFZO0FBQ3hDLFNBQVMsdUJBQXVCO0FBV3pCLE1BQU0sMkJBQTJCO0FBQ3hDLE1BQU0sWUFBWSxJQUFJLFdBQVcsSUFBSSxrQkFBa0IsQ0FBQyxDQUFDO0FBR3pELFNBQVMsWUFBWSxXQUFtQixNQUFjLGVBQWtDO0FBQ3RGLFFBQU0sV0FBVyxRQUFRLGFBQWEsVUFBVSxJQUFJO0FBQ3BELFdBQVMsVUFBVSxHQUFHLFdBQVcsVUFBVSxXQUFXO0FBRXBELG9CQUFnQjtBQUNoQixRQUFJO0FBQ0YsaUJBQVcsV0FBVyxJQUFJO0FBQzFCO0FBQUEsSUFDRixTQUFTLE9BQU87QUFDZCxZQUFNLE9BQVEsTUFBZ0M7QUFDOUMsVUFBSSxRQUFRLGFBQWEsV0FBWSxTQUFTLFlBQVksU0FBUyxXQUFXLFNBQVMsUUFBVSxPQUFNO0FBQ3ZHLFVBQUksWUFBWTtBQUNkLGNBQU0sSUFBSSxNQUFNLG1DQUFtQyxPQUFPLE9BQU8sQ0FBQyxjQUFjLElBQUksSUFBSSxFQUFFLE9BQU8sTUFBTSxDQUFDO0FBQzFHLGNBQVEsS0FBSyxXQUFXLEdBQUcsR0FBRyxLQUFLLElBQUksS0FBSyxNQUFNLFVBQVUs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
