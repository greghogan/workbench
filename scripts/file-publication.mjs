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
  readFileSync
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
  const check = () => {
    const actual = existsSync(path) ? readFileSync(path) : void 0;
    if (expected === void 0 ? actual !== void 0 : actual === void 0 || !Buffer.from(expected).equals(actual))
      throw new Error(`${path}: file changed before replacement; preserve the changes and inspect a fresh plan`);
  };
  check();
  if (expected === void 0) writeNew(path, contents, mode);
  else writeAtomic(path, contents, mode, check);
}
export {
  publicationTarget,
  publicationTemporaryGlob,
  publishFile,
  stageFile,
  writeAtomic,
  writeNew
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGUtcHVibGljYXRpb24ubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZmNobW9kU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgbGlua1N5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIHJlYWRGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4vZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhZ2VkRmlsZSB7XG4gIHJlYWRvbmx5IHRlbXBvcmFyeTogc3RyaW5nO1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIHB1Ymxpc2goYmVmb3JlUmVwbGFjZT86ICgpID0+IHZvaWQpOiB2b2lkO1xuICBkaXNjYXJkKCk6IHZvaWQ7XG59XG5leHBvcnQgaW50ZXJmYWNlIFB1YmxpY2F0aW9uT3B0aW9ucyB7XG4gIGNyZWF0ZVBhcmVudD86IGJvb2xlYW47XG59XG5leHBvcnQgY29uc3QgcHVibGljYXRpb25UZW1wb3JhcnlHbG9iID0gXCIuKi4/Pz8/Pz8/Py0/Pz8/LT8/Pz8tPz8/Py0/Pz8/Pz8/Pz8/Pz8udG1wXCI7XG5jb25zdCByZXRyeVdhaXQgPSBuZXcgSW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoNCkpO1xuXG4vKiogV2luZG93cyByZWFkZXJzIGFuZCBzY2FubmVycyBjYW4gdGVtcG9yYXJpbHkgZGVueSByZXBsYWNlbWVudDsgbmV2ZXIgdW5saW5rIHRoZSBkZXN0aW5hdGlvbi4gKi9cbmZ1bmN0aW9uIHJlcGxhY2VGaWxlKHRlbXBvcmFyeTogc3RyaW5nLCBwYXRoOiBzdHJpbmcsIGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIGNvbnN0IGF0dGVtcHRzID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gOCA6IDE7XG4gIGZvciAobGV0IGF0dGVtcHQgPSAxOyBhdHRlbXB0IDw9IGF0dGVtcHRzOyBhdHRlbXB0KyspIHtcbiAgICAvLyBBIGNvbmZsaWN0aW5nIGVkaXQgZHVyaW5nIGEgc2hhcmluZyB2aW9sYXRpb24gbXVzdCBzdGlsbCBwcmV2ZW50IHB1YmxpY2F0aW9uLlxuICAgIGJlZm9yZVJlcGxhY2U/LigpO1xuICAgIHRyeSB7XG4gICAgICByZW5hbWVTeW5jKHRlbXBvcmFyeSwgcGF0aCk7XG4gICAgICByZXR1cm47XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIiB8fCAoY29kZSAhPT0gXCJFQUNDRVNcIiAmJiBjb2RlICE9PSBcIkVQRVJNXCIgJiYgY29kZSAhPT0gXCJFQlVTWVwiKSkgdGhyb3cgZXJyb3I7XG4gICAgICBpZiAoYXR0ZW1wdCA9PT0gYXR0ZW1wdHMpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQXRvbWljIHJlcGxhY2VtZW50IGZhaWxlZCBhZnRlciAke1N0cmluZyhhdHRlbXB0KX0gYXR0ZW1wdHM6ICR7cGF0aH1gLCB7IGNhdXNlOiBlcnJvciB9KTtcbiAgICAgIEF0b21pY3Mud2FpdChyZXRyeVdhaXQsIDAsIDAsIE1hdGgubWluKDI1ICogMiAqKiAoYXR0ZW1wdCAtIDEpLCAyMDApKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIElkZW50aWZ5IG9ubHkgdGhlIFVVSUQgY2FuZGlkYXRlIG5hbWVzIG93bmVkIGJ5IHRoaXMgcHVibGlzaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1YmxpY2F0aW9uVGFyZ2V0KHBhdGg6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IG1hdGNoID0gL15cXC4oLispXFwuW2EtZjAtOV17OH0tW2EtZjAtOV17NH0tW2EtZjAtOV17NH0tW2EtZjAtOV17NH0tW2EtZjAtOV17MTJ9XFwudG1wJC8uZXhlYyhiYXNlbmFtZShwYXRoKSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8gam9pbihkaXJuYW1lKHBhdGgpLCBtYXRjaFsxXSkgOiB1bmRlZmluZWQ7XG59XG4vKiogRmluaXNoIHdyaXRpbmcgYW5kIGNsb3NpbmcgZXZlcnkgY2FuZGlkYXRlIGJlZm9yZSBwdWJsaXNoaW5nIGEgYmF0Y2guICovXG5leHBvcnQgZnVuY3Rpb24gc3RhZ2VGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LFxuICBtb2RlPzogbnVtYmVyLFxuICBvcHRpb25zOiBQdWJsaWNhdGlvbk9wdGlvbnMgPSB7fSxcbik6IFN0YWdlZEZpbGUge1xuICBpZiAob3B0aW9ucy5jcmVhdGVQYXJlbnQgIT09IGZhbHNlKSBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IGpvaW4oZGlybmFtZShwYXRoKSwgYC4ke2Jhc2VuYW1lKHBhdGgpfS4ke3JhbmRvbVVVSUQoKX0udG1wYCk7XG4gIGxldCBkZXNjcmlwdG9yOiBudW1iZXIgfCB1bmRlZmluZWQgPSBvcGVuU3luYyh0ZW1wb3JhcnksIFwid3hcIiwgbW9kZSk7XG4gIGNvbnN0IHN0YWdlZDogU3RhZ2VkRmlsZSA9IHtcbiAgICBwYXRoLFxuICAgIHRlbXBvcmFyeSxcbiAgICBwdWJsaXNoKGJlZm9yZVJlcGxhY2UpIHtcbiAgICAgIHJlcGxhY2VGaWxlKHRlbXBvcmFyeSwgcGF0aCwgYmVmb3JlUmVwbGFjZSk7XG4gICAgfSxcbiAgICBkaXNjYXJkKCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdW5saW5rU3luYyh0ZW1wb3JhcnkpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRU5PRU5UXCIpIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhkZXNjcmlwdG9yLCBjb250ZW50cyk7XG4gICAgaWYgKG1vZGUgIT09IHVuZGVmaW5lZCkgZmNobW9kU3luYyhkZXNjcmlwdG9yLCBtb2RlKTtcbiAgICBjb25zdCB3cml0dGVuID0gZGVzY3JpcHRvcjtcbiAgICBkZXNjcmlwdG9yID0gdW5kZWZpbmVkOyAvLyBBIGZhaWxlZCBjbG9zZSBtYXkgaGF2ZSByZWxlYXNlZCBpdHMgZGVzY3JpcHRvciBhbHJlYWR5LlxuICAgIGNsb3NlU3luYyh3cml0dGVuKTtcbiAgICByZXR1cm4gc3RhZ2VkO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IGZhaWx1cmVzOiB1bmtub3duW10gPSBbXTtcbiAgICBpZiAoZGVzY3JpcHRvciAhPT0gdW5kZWZpbmVkKVxuICAgICAgdHJ5IHtcbiAgICAgICAgY2xvc2VTeW5jKGRlc2NyaXB0b3IpO1xuICAgICAgfSBjYXRjaCAoY2xlYW51cCkge1xuICAgICAgICBmYWlsdXJlcy5wdXNoKGNsZWFudXApO1xuICAgICAgfVxuICAgIHRyeSB7XG4gICAgICBzdGFnZWQuZGlzY2FyZCgpO1xuICAgIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goY2xlYW51cCk7XG4gICAgfVxuICAgIGlmIChmYWlsdXJlcy5sZW5ndGgpXG4gICAgICB0aHJvdyBjb21iaW5lRmFpbHVyZXMoXG4gICAgICAgIGVycm9yLFxuICAgICAgICBuZXcgQWdncmVnYXRlRXJyb3IoZmFpbHVyZXMsIGBUZW1wb3JhcnkgZmlsZSBjbGVhbnVwIGZhaWxlZDogJHt0ZW1wb3Jhcnl9YCksXG4gICAgICAgIFwiRmlsZSBwcmVwYXJhdGlvbiBhbmQgY2xlYW51cCBmYWlsZWRcIixcbiAgICAgICk7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cbmZ1bmN0aW9uIHB1Ymxpc2goc3RhZ2VkOiBTdGFnZWRGaWxlLCBhY3Rpb246ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgbGV0IGZhaWx1cmU6IHVua25vd247XG4gIGxldCBmYWlsZWQgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBhY3Rpb24oKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsZWQgPSB0cnVlO1xuICAgIGZhaWx1cmUgPSBlcnJvcjtcbiAgfVxuICB0cnkge1xuICAgIHN0YWdlZC5kaXNjYXJkKCk7XG4gIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICBpZiAoZmFpbGVkKSB0aHJvdyBjb21iaW5lRmFpbHVyZXMoZmFpbHVyZSwgY2xlYW51cCwgYEZpbGUgcHVibGljYXRpb24gYW5kIGNsZWFudXAgZmFpbGVkOiAke3N0YWdlZC50ZW1wb3Jhcnl9YCk7XG4gICAgdGhyb3cgY2xlYW51cDtcbiAgfVxuICBpZiAoZmFpbGVkKSB0aHJvdyBlcnJvckZyb20oZmFpbHVyZSk7XG59XG5leHBvcnQgZnVuY3Rpb24gd3JpdGVBdG9taWMoXG4gIHBhdGg6IHN0cmluZyxcbiAgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXksXG4gIG1vZGU/OiBudW1iZXIsXG4gIGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkLFxuICBvcHRpb25zOiBQdWJsaWNhdGlvbk9wdGlvbnMgPSB7fSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFnZWQgPSBzdGFnZUZpbGUocGF0aCwgY29udGVudHMsIG1vZGUsIG9wdGlvbnMpO1xuICBwdWJsaXNoKHN0YWdlZCwgKCkgPT4ge1xuICAgIHN0YWdlZC5wdWJsaXNoKGJlZm9yZVJlcGxhY2UpO1xuICB9KTtcbn1cbi8qKiBQdWJsaXNoIGEgY29tcGxldGVseSB3cml0dGVuIG5ldyBmaWxlIHdpdGhvdXQgcmVwbGFjaW5nIGFuIGV4aXN0aW5nIGRlc3RpbmF0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlTmV3KHBhdGg6IHN0cmluZywgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXksIG1vZGU/OiBudW1iZXIpOiB2b2lkIHtcbiAgY29uc3Qgc3RhZ2VkID0gc3RhZ2VGaWxlKHBhdGgsIGNvbnRlbnRzLCBtb2RlKTtcbiAgcHVibGlzaChzdGFnZWQsICgpID0+IHtcbiAgICBsaW5rU3luYyhzdGFnZWQudGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSk7XG59XG4vKiogRXhwZWN0ZWQgYnl0ZXMgYXJlIGNoZWNrZWQgYXQgdGhlIGZpbmFsIHJlcGxhY2VtZW50IGJvdW5kYXJ5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1Ymxpc2hGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LFxuICBleHBlY3RlZDogVWludDhBcnJheSB8IHVuZGVmaW5lZCxcbiAgbW9kZT86IG51bWJlcixcbik6IHZvaWQge1xuICBjb25zdCBjaGVjayA9ICgpID0+IHtcbiAgICBjb25zdCBhY3R1YWwgPSBleGlzdHNTeW5jKHBhdGgpID8gcmVhZEZpbGVTeW5jKHBhdGgpIDogdW5kZWZpbmVkO1xuICAgIGlmIChleHBlY3RlZCA9PT0gdW5kZWZpbmVkID8gYWN0dWFsICE9PSB1bmRlZmluZWQgOiBhY3R1YWwgPT09IHVuZGVmaW5lZCB8fCAhQnVmZmVyLmZyb20oZXhwZWN0ZWQpLmVxdWFscyhhY3R1YWwpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke3BhdGh9OiBmaWxlIGNoYW5nZWQgYmVmb3JlIHJlcGxhY2VtZW50OyBwcmVzZXJ2ZSB0aGUgY2hhbmdlcyBhbmQgaW5zcGVjdCBhIGZyZXNoIHBsYW5gKTtcbiAgfTtcbiAgY2hlY2soKTtcbiAgaWYgKGV4cGVjdGVkID09PSB1bmRlZmluZWQpIHdyaXRlTmV3KHBhdGgsIGNvbnRlbnRzLCBtb2RlKTtcbiAgZWxzZSB3cml0ZUF0b21pYyhwYXRoLCBjb250ZW50cywgbW9kZSwgY2hlY2spO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxrQkFBa0I7QUFDM0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsVUFBVSxTQUFTLFlBQVk7QUFDeEMsU0FBUyx1QkFBdUI7QUFXekIsTUFBTSwyQkFBMkI7QUFDeEMsTUFBTSxZQUFZLElBQUksV0FBVyxJQUFJLGtCQUFrQixDQUFDLENBQUM7QUFHekQsU0FBUyxZQUFZLFdBQW1CLE1BQWMsZUFBa0M7QUFDdEYsUUFBTSxXQUFXLFFBQVEsYUFBYSxVQUFVLElBQUk7QUFDcEQsV0FBUyxVQUFVLEdBQUcsV0FBVyxVQUFVLFdBQVc7QUFFcEQsb0JBQWdCO0FBQ2hCLFFBQUk7QUFDRixpQkFBVyxXQUFXLElBQUk7QUFDMUI7QUFBQSxJQUNGLFNBQVMsT0FBTztBQUNkLFlBQU0sT0FBUSxNQUFnQztBQUM5QyxVQUFJLFFBQVEsYUFBYSxXQUFZLFNBQVMsWUFBWSxTQUFTLFdBQVcsU0FBUyxRQUFVLE9BQU07QUFDdkcsVUFBSSxZQUFZO0FBQ2QsY0FBTSxJQUFJLE1BQU0sbUNBQW1DLE9BQU8sT0FBTyxDQUFDLGNBQWMsSUFBSSxJQUFJLEVBQUUsT0FBTyxNQUFNLENBQUM7QUFDMUcsY0FBUSxLQUFLLFdBQVcsR0FBRyxHQUFHLEtBQUssSUFBSSxLQUFLLE1BQU0sVUFBVSxJQUFJLEdBQUcsQ0FBQztBQUFBLElBQ3RFO0FBQUEsRUFDRjtBQUNGO0FBR08sU0FBUyxrQkFBa0IsTUFBa0M7QUFDbEUsUUFBTSxRQUFRLDhFQUE4RSxLQUFLLFNBQVMsSUFBSSxDQUFDO0FBQy9HLFNBQU8sUUFBUSxD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
