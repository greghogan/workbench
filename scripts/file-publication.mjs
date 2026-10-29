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
function publicationTarget(path) {
  const match = /^\.(.+)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(basename(path));
  return match?.[1] ? join(dirname(path), match[1]) : void 0;
}
function stageFile(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor = openSync(temporary, "wx", mode);
  const staged = {
    path,
    temporary,
    publish(beforeReplace) {
      beforeReplace?.();
      renameSync(temporary, path);
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
function writeAtomic(path, contents, mode, beforeReplace) {
  const staged = stageFile(path, contents, mode);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGUtcHVibGljYXRpb24ubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZmNobW9kU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgbGlua1N5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIHJlYWRGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4vZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhZ2VkRmlsZSB7XG4gIHJlYWRvbmx5IHRlbXBvcmFyeTogc3RyaW5nO1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIHB1Ymxpc2goYmVmb3JlUmVwbGFjZT86ICgpID0+IHZvaWQpOiB2b2lkO1xuICBkaXNjYXJkKCk6IHZvaWQ7XG59XG5leHBvcnQgY29uc3QgcHVibGljYXRpb25UZW1wb3JhcnlHbG9iID0gXCIuKi4/Pz8/Pz8/Py0/Pz8/LT8/Pz8tPz8/Py0/Pz8/Pz8/Pz8/Pz8udG1wXCI7XG5cbi8qKiBJZGVudGlmeSBvbmx5IHRoZSBVVUlEIGNhbmRpZGF0ZSBuYW1lcyBvd25lZCBieSB0aGlzIHB1Ymxpc2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwdWJsaWNhdGlvblRhcmdldChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBtYXRjaCA9IC9eXFwuKC4rKVxcLlthLWYwLTldezh9LVthLWYwLTldezR9LVthLWYwLTldezR9LVthLWYwLTldezR9LVthLWYwLTldezEyfVxcLnRtcCQvLmV4ZWMoYmFzZW5hbWUocGF0aCkpO1xuICByZXR1cm4gbWF0Y2g/LlsxXSA/IGpvaW4oZGlybmFtZShwYXRoKSwgbWF0Y2hbMV0pIDogdW5kZWZpbmVkO1xufVxuLyoqIEZpbmlzaCB3cml0aW5nIGFuZCBjbG9zaW5nIGV2ZXJ5IGNhbmRpZGF0ZSBiZWZvcmUgcHVibGlzaGluZyBhIGJhdGNoLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YWdlRmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5LCBtb2RlPzogbnVtYmVyKTogU3RhZ2VkRmlsZSB7XG4gIG1rZGlyU3luYyhkaXJuYW1lKHBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gam9pbihkaXJuYW1lKHBhdGgpLCBgLiR7YmFzZW5hbWUocGF0aCl9LiR7cmFuZG9tVVVJRCgpfS50bXBgKTtcbiAgbGV0IGRlc2NyaXB0b3I6IG51bWJlciB8IHVuZGVmaW5lZCA9IG9wZW5TeW5jKHRlbXBvcmFyeSwgXCJ3eFwiLCBtb2RlKTtcbiAgY29uc3Qgc3RhZ2VkOiBTdGFnZWRGaWxlID0ge1xuICAgIHBhdGgsXG4gICAgdGVtcG9yYXJ5LFxuICAgIHB1Ymxpc2goYmVmb3JlUmVwbGFjZSkge1xuICAgICAgYmVmb3JlUmVwbGFjZT8uKCk7XG4gICAgICByZW5hbWVTeW5jKHRlbXBvcmFyeSwgcGF0aCk7XG4gICAgfSxcbiAgICBkaXNjYXJkKCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdW5saW5rU3luYyh0ZW1wb3JhcnkpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRU5PRU5UXCIpIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhkZXNjcmlwdG9yLCBjb250ZW50cyk7XG4gICAgaWYgKG1vZGUgIT09IHVuZGVmaW5lZCkgZmNobW9kU3luYyhkZXNjcmlwdG9yLCBtb2RlKTtcbiAgICBjb25zdCB3cml0dGVuID0gZGVzY3JpcHRvcjtcbiAgICBkZXNjcmlwdG9yID0gdW5kZWZpbmVkOyAvLyBBIGZhaWxlZCBjbG9zZSBtYXkgaGF2ZSByZWxlYXNlZCBpdHMgZGVzY3JpcHRvciBhbHJlYWR5LlxuICAgIGNsb3NlU3luYyh3cml0dGVuKTtcbiAgICByZXR1cm4gc3RhZ2VkO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IGZhaWx1cmVzOiB1bmtub3duW10gPSBbXTtcbiAgICBpZiAoZGVzY3JpcHRvciAhPT0gdW5kZWZpbmVkKVxuICAgICAgdHJ5IHtcbiAgICAgICAgY2xvc2VTeW5jKGRlc2NyaXB0b3IpO1xuICAgICAgfSBjYXRjaCAoY2xlYW51cCkge1xuICAgICAgICBmYWlsdXJlcy5wdXNoKGNsZWFudXApO1xuICAgICAgfVxuICAgIHRyeSB7XG4gICAgICBzdGFnZWQuZGlzY2FyZCgpO1xuICAgIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goY2xlYW51cCk7XG4gICAgfVxuICAgIGlmIChmYWlsdXJlcy5sZW5ndGgpXG4gICAgICB0aHJvdyBjb21iaW5lRmFpbHVyZXMoXG4gICAgICAgIGVycm9yLFxuICAgICAgICBuZXcgQWdncmVnYXRlRXJyb3IoZmFpbHVyZXMsIGBUZW1wb3JhcnkgZmlsZSBjbGVhbnVwIGZhaWxlZDogJHt0ZW1wb3Jhcnl9YCksXG4gICAgICAgIFwiRmlsZSBwcmVwYXJhdGlvbiBhbmQgY2xlYW51cCBmYWlsZWRcIixcbiAgICAgICk7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cbmZ1bmN0aW9uIHB1Ymxpc2goc3RhZ2VkOiBTdGFnZWRGaWxlLCBhY3Rpb246ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgbGV0IGZhaWx1cmU6IHVua25vd247XG4gIGxldCBmYWlsZWQgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBhY3Rpb24oKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsZWQgPSB0cnVlO1xuICAgIGZhaWx1cmUgPSBlcnJvcjtcbiAgfVxuICB0cnkge1xuICAgIHN0YWdlZC5kaXNjYXJkKCk7XG4gIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICBpZiAoZmFpbGVkKSB0aHJvdyBjb21iaW5lRmFpbHVyZXMoZmFpbHVyZSwgY2xlYW51cCwgYEZpbGUgcHVibGljYXRpb24gYW5kIGNsZWFudXAgZmFpbGVkOiAke3N0YWdlZC50ZW1wb3Jhcnl9YCk7XG4gICAgdGhyb3cgY2xlYW51cDtcbiAgfVxuICBpZiAoZmFpbGVkKSB0aHJvdyBlcnJvckZyb20oZmFpbHVyZSk7XG59XG5leHBvcnQgZnVuY3Rpb24gd3JpdGVBdG9taWMoXG4gIHBhdGg6IHN0cmluZyxcbiAgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXksXG4gIG1vZGU/OiBudW1iZXIsXG4gIGJlZm9yZVJlcGxhY2U/OiAoKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWdlZCA9IHN0YWdlRmlsZShwYXRoLCBjb250ZW50cywgbW9kZSk7XG4gIHB1Ymxpc2goc3RhZ2VkLCAoKSA9PiB7XG4gICAgc3RhZ2VkLnB1Ymxpc2goYmVmb3JlUmVwbGFjZSk7XG4gIH0pO1xufVxuLyoqIFB1Ymxpc2ggYSBjb21wbGV0ZWx5IHdyaXR0ZW4gbmV3IGZpbGUgd2l0aG91dCByZXBsYWNpbmcgYW4gZXhpc3RpbmcgZGVzdGluYXRpb24uICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVOZXcocGF0aDogc3RyaW5nLCBjb250ZW50czogc3RyaW5nIHwgVWludDhBcnJheSwgbW9kZT86IG51bWJlcik6IHZvaWQge1xuICBjb25zdCBzdGFnZWQgPSBzdGFnZUZpbGUocGF0aCwgY29udGVudHMsIG1vZGUpO1xuICBwdWJsaXNoKHN0YWdlZCwgKCkgPT4ge1xuICAgIGxpbmtTeW5jKHN0YWdlZC50ZW1wb3JhcnksIHBhdGgpO1xuICB9KTtcbn1cbi8qKiBFeHBlY3RlZCBieXRlcyBhcmUgY2hlY2tlZCBhdCB0aGUgZmluYWwgcmVwbGFjZW1lbnQgYm91bmRhcnkuICovXG5leHBvcnQgZnVuY3Rpb24gcHVibGlzaEZpbGUoXG4gIHBhdGg6IHN0cmluZyxcbiAgY29udGVudHM6IHN0cmluZyB8IFVpbnQ4QXJyYXksXG4gIGV4cGVjdGVkOiBVaW50OEFycmF5IHwgdW5kZWZpbmVkLFxuICBtb2RlPzogbnVtYmVyLFxuKTogdm9pZCB7XG4gIGNvbnN0IGNoZWNrID0gKCkgPT4ge1xuICAgIGNvbnN0IGFjdHVhbCA9IGV4aXN0c1N5bmMocGF0aCkgPyByZWFkRmlsZVN5bmMocGF0aCkgOiB1bmRlZmluZWQ7XG4gICAgaWYgKGV4cGVjdGVkID09PSB1bmRlZmluZWQgPyBhY3R1YWwgIT09IHVuZGVmaW5lZCA6IGFjdHVhbCA9PT0gdW5kZWZpbmVkIHx8ICFCdWZmZXIuZnJvbShleHBlY3RlZCkuZXF1YWxzKGFjdHVhbCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7cGF0aH06IGZpbGUgY2hhbmdlZCBiZWZvcmUgcmVwbGFjZW1lbnQ7IHByZXNlcnZlIHRoZSBjaGFuZ2VzIGFuZCBpbnNwZWN0IGEgZnJlc2ggcGxhbmApO1xuICB9O1xuICBjaGVjaygpO1xuICBpZiAoZXhwZWN0ZWQgPT09IHVuZGVmaW5lZCkgd3JpdGVOZXcocGF0aCwgY29udGVudHMsIG1vZGUpO1xuICBlbHNlIHdyaXRlQXRvbWljKHBhdGgsIGNvbnRlbnRzLCBtb2RlLCBjaGVjayk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxVQUFVLFNBQVMsWUFBWTtBQUN4QyxTQUFTLHVCQUF1QjtBQVF6QixNQUFNLDJCQUEyQjtBQUdqQyxTQUFTLGtCQUFrQixNQUFrQztBQUNsRSxRQUFNLFFBQVEsOEVBQThFLEtBQUssU0FBUyxJQUFJLENBQUM7QUFDL0csU0FBTyxRQUFRLENBQUMsSUFBSSxLQUFLLFFBQVEsSUFBSSxHQUFHLE1BQU0sQ0FBQyxDQUFDLElBQUk7QUFDdEQ7QUFFTyxTQUFTLFVBQVUsTUFBYyxVQUErQixNQUEyQjtBQUNoRyxZQUFVLFFBQVEsSUFBSSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDNUMsUUFBTSxZQUFZLEtBQUssUUFBUSxJQUFJLEdBQUcsSUFBSSxTQUFTLElBQUksQ0FBQyxJQUFJLFdBQVcsQ0FBQyxNQUFNO0FBQzlFLE1BQUksYUFBaUMsU0FBUyxXQUFXLE1BQU0sSUFBSTtBQUNuRSxRQUFNLFNBQXFCO0FBQUEsSUFDekI7QUFBQSxJQUNBO0FBQUEsSUFDQSxRQUFRLGVBQWU7QUFDckIsc0JBQWdCO0FBQ2hCLGlCQUFXLFdBQVcsSUFBSTtBQUFBLElBQzVCO0FBQUEsSUFDQSxVQUFVO0FBQ1IsVUFBSTtBQUNGLG1CQUFXLFNBQVM7QUFBQSxNQUN0QixTQUFTLE9BQU87QUFDZCxZQUFLLE1BQWdDLFNBQVMsU0FBVSxPQUFNO0FBQUEsTUFDaEU7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLE1BQUk7QUFDRixrQkFBYyxZQUFZLFFBQVE7QUFDbEMsUUFBSSxTQUFTLE9BQVcsWUFBVyxZQUFZLElBQUk7QUFDbkQsVUFBTSxVQUFVO0FBQ2hCLGlCQUFhO0FBQ2IsY0FBVSxPQUFPO0FBQ2pCLFdBQU87QUFBQSxFQUNULFNBQVMsT0FBTztBQUNkLFVBQU0sV0FBc0IsQ0FBQztBQUM3QixRQUFJLGVBQWU7QUFDakIsVUFBSTtBQUNGLGtCQUFVLFVBQVU7QUFBQSxNQUN0QixTQUFTLFNBQVM7QUFDaEIsaUJBQVMsS0FBSyxPQUFPO0FBQUEsTUFDdkI7QUFDRixRQUFJO0FBQ0YsYUFBTyxRQUFRO0FBQUEsSUFDakIsU0FBUyxTQUFTO0FBQ2hCLGVBQVMsS0FBSyxPQUFPO0FBQUEsSUFDdkI7QUFDQSxRQUFJLFNBQVM7QUFDWCxZQUFNO0FBQUEsUUFDSjtBQUFBLFFBQ0EsSUFBSSxlQUFlLFVBQVUsa0NBQWtDLFNBQVMsRUFBRTtBQUFBLFFBQzFFO0FBQUEsTUFDRjtBQUNGLFVBQU07QUFBQSxFQUNSO0FBQ0Y7QUFDQSxTQUFTLFFBQVEsUUFBb0IsUUFBMEI7QUFDN0QsTUFBSTtBQUNKLE1BQUksU0FBUztBQUNiLE1BQUk7QUFDRixXQUFPO0FBQUEsRUFDVCxTQUFTLE9BQU87QUFDZCxhQUFTO0FBQ1QsY0FBVTtBQUFBLEVBQ1o7QUFDQSxNQUFJO0FBQ0YsV0FBTyxRQUFRO0FBQUEsRUFDakIsU0FBUyxTQUFTO0FBQ2hCLFFBQUksT0FBUSxPQUFNLGdCQUFnQixTQUFTLFNBQVMsd0NBQXdDLE9BQU8sU0FBUyxFQUFFO0FBQzlHLFVBQU07QUFBQSxFQUNSO0FBQ0EsTUFBSSxPQUFRLE9BQU0sVUFBVSxPQUFPO0FBQ3JDO0FBQ08sU0FBUyxZQUNkLE1BQ0EsVUFDQSxNQUNBLGVBQ007QUFDTixRQUFNLFNBQVMsVUFBVSxNQUFNLFVBQVUsSUFBSTtBQUM3QyxVQUFRLFFBQVEsTUFBTTtBQUNwQixXQUFPLFFBQVEsYUFBYTtBQUFBLEVBQzlCLENBQUM7QUFDSDtBQUVPLFNBQVMsU0FBUyxNQUFjLFVBQStCLE1BQXFCO0FBQ3pGLFFBQU0sU0FBUyxVQUFVLE1BQU0sVUFBVSxJQUFJO0FBQzdDLFVBQVEsUUFBUSxNQUFNO0FBQ3BCLGFBQVMsT0FBTyxXQUFXLElBQUk7QUFBQSxFQUNqQyxDQUFDO0FBQ0g7QUFFTyxTQUFTLFlBQ2QsTUFDQSxVQUNBLFVBQ0EsTUFDTTtBQUNOLFFBQU0sUUFBUSxNQUFNO0FBQ2xCLFVBQU0sU0FBUyxXQUFXLElBQUksSUFBSSxhQUFhLElBQUksSUFBSTtBQUN2RCxRQUFJLGFBQWEsU0FBWSxXQUFXLFNBQVksV0FBVyxVQUFhLENBQUMsT0FBTyxLQUFLLFFBQVEsRUFBRSxPQUFPLE1BQU07QUFDOUcsWUFBTSxJQUFJLE1BQU0sR0FBRyxJQUFJLGtGQUFrRjtBQUFBLEVBQzdHO0FBQ0EsUUFBTTtBQUNOLE1BQUksYUFBYSxPQUFXLFVBQVMsTUFBTSxVQUFVLElBQUk7QUFBQSxNQUNwRCxhQUFZLE1BQU0sVUFBVSxNQUFNLEtBQUs7QUFDOUM7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9maWxlLXB1YmxpY2F0aW9uLm1qcyJ9
