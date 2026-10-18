// Generated from managed-process.mts; edit the TypeScript source.
import { isRecord, errorFrom } from "./values.mjs";
import { spawn } from "node:child_process";
async function withManagedProcesses(action) {
  const controller = new AbortController();
  const cleanups = [];
  const interrupt = () => {
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const scope = {
    defer: (cleanup) => cleanups.push(cleanup),
    async run(command, args, { capture = false, cleanup = false, missing = false, cwd, env, limit = 16 * 1024 * 1024 } = {}) {
      if (!cleanup) controller.signal.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          detached: process.platform !== "win32",
          stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
        });
        const chunks = [];
        let size = 0, failure, escalation;
        const stop = (signal) => {
          if (!child.pid) return;
          try {
            if (process.platform === "win32") child.kill(signal);
            else process.kill(-child.pid, signal);
          } catch (error) {
            if (!isRecord(error) || error.code !== "ESRCH") failure ??= errorFrom(error);
          }
        };
        const abort = () => {
          failure ??= new Error("Managed preparation cancelled");
          stop("SIGTERM");
          escalation ??= setTimeout(() => {
            stop("SIGKILL");
          }, 2e3);
        };
        child.stdout?.on("data", (chunk) => {
          size += chunk.length;
          if (size <= limit) chunks.push(chunk);
          else {
            failure ??= new Error(`${command}: captured output exceeds ${String(limit)} bytes`);
            abort();
          }
        });
        child.once("error", (error) => {
          failure ??= errorFrom(error);
        });
        child.once("close", (code, signal) => {
          controller.signal.removeEventListener("abort", abort);
          if (escalation) clearTimeout(escalation);
          if (missing && isRecord(failure) && failure.code === "ENOENT") resolve(void 0);
          else if (failure) reject(failure);
          else if (code !== 0) reject(new Error(`${command} failed: ${String(code ?? signal)}`));
          else resolve(Buffer.concat(chunks).toString("utf8").trim());
        });
        if (!cleanup) {
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        }
      });
    }
  };
  const failures = [];
  let result;
  try {
    result = await action(scope);
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map((error) => String(error)).join("; "));
  return result;
}
export {
  withManagedProcesses
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtcHJvY2Vzcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNSZWNvcmQsIGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmV4cG9ydCBpbnRlcmZhY2UgTWFuYWdlZFJ1bk9wdGlvbnMge1xuICBjYXB0dXJlPzogYm9vbGVhbjtcbiAgY2xlYW51cD86IGJvb2xlYW47XG4gIG1pc3Npbmc/OiBib29sZWFuO1xuICBjd2Q/OiBzdHJpbmc7XG4gIGVudj86IE5vZGVKUy5Qcm9jZXNzRW52O1xuICBsaW1pdD86IG51bWJlcjtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgTWFuYWdlZFByb2Nlc3NTY29wZSB7XG4gIGRlZmVyKGNsZWFudXA6ICgpID0+IHVua25vd24pOiB2b2lkO1xuICBydW4oXG4gICAgY29tbWFuZDogc3RyaW5nLFxuICAgIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICAgIG9wdGlvbnM6IE1hbmFnZWRSdW5PcHRpb25zICYgeyBtaXNzaW5nOiB0cnVlIH0sXG4gICk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIG9wdGlvbnM/OiBNYW5hZ2VkUnVuT3B0aW9ucyAmIHsgbWlzc2luZz86IGZhbHNlIH0pOiBQcm9taXNlPHN0cmluZz47XG59XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuLyoqIFByZXBhcmF0aW9uIG93bnMgY2hpbGRyZW4gdW50aWwgZXhpdCBhbmQgYXR0ZW1wdHMgZXZlcnkgcmVnaXN0ZXJlZCBjbGVhbnVwLCBpbmNsdWRpbmcgYWZ0ZXIgY2FuY2VsbGF0aW9uLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhNYW5hZ2VkUHJvY2Vzc2VzPFQ+KGFjdGlvbjogKHNjb3BlOiBNYW5hZ2VkUHJvY2Vzc1Njb3BlKSA9PiBUIHwgUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBjbGVhbnVwczogKCgpID0+IHVua25vd24pW10gPSBbXTtcbiAgY29uc3QgaW50ZXJydXB0ID0gKCkgPT4ge1xuICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgfTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICBjb25zdCBzY29wZSA9IHtcbiAgICBkZWZlcjogKGNsZWFudXA6ICgpID0+IHVua25vd24pID0+IGNsZWFudXBzLnB1c2goY2xlYW51cCksXG4gICAgYXN5bmMgcnVuKFxuICAgICAgY29tbWFuZDogc3RyaW5nLFxuICAgICAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gICAgICB7IGNhcHR1cmUgPSBmYWxzZSwgY2xlYW51cCA9IGZhbHNlLCBtaXNzaW5nID0gZmFsc2UsIGN3ZCwgZW52LCBsaW1pdCA9IDE2ICogMTAyNCAqIDEwMjQgfTogTWFuYWdlZFJ1bk9wdGlvbnMgPSB7fSxcbiAgICApIHtcbiAgICAgIGlmICghY2xlYW51cCkgY29udHJvbGxlci5zaWduYWwudGhyb3dJZkFib3J0ZWQoKTtcbiAgICAgIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgY29uc3QgY2hpbGQgPSBzcGF3bihjb21tYW5kLCBhcmdzLCB7XG4gICAgICAgICAgY3dkLFxuICAgICAgICAgIGVudixcbiAgICAgICAgICBkZXRhY2hlZDogcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiLFxuICAgICAgICAgIHN0ZGlvOiBjYXB0dXJlID8gW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0gOiBcImluaGVyaXRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICAgICAgbGV0IHNpemUgPSAwLFxuICAgICAgICAgIGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkLFxuICAgICAgICAgIGVzY2FsYXRpb246IE5vZGVKUy5UaW1lb3V0IHwgdW5kZWZpbmVkO1xuICAgICAgICBjb25zdCBzdG9wID0gKHNpZ25hbDogTm9kZUpTLlNpZ25hbHMpID0+IHtcbiAgICAgICAgICBpZiAoIWNoaWxkLnBpZCkgcmV0dXJuO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSBjaGlsZC5raWxsKHNpZ25hbCk7XG4gICAgICAgICAgICBlbHNlIHByb2Nlc3Mua2lsbCgtY2hpbGQucGlkLCBzaWduYWwpO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBpZiAoIWlzUmVjb3JkKGVycm9yKSB8fCBlcnJvci5jb2RlICE9PSBcIkVTUkNIXCIpIGZhaWx1cmUgPz89IGVycm9yRnJvbShlcnJvcik7XG4gICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICBjb25zdCBhYm9ydCA9ICgpID0+IHtcbiAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoXCJNYW5hZ2VkIHByZXBhcmF0aW9uIGNhbmNlbGxlZFwiKTtcbiAgICAgICAgICBzdG9wKFwiU0lHVEVSTVwiKTtcbiAgICAgICAgICBlc2NhbGF0aW9uID8/PSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgICAgICAgIH0sIDIwMDApO1xuICAgICAgICB9O1xuICAgICAgICBjaGlsZC5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgICAgIHNpemUgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgIGlmIChzaXplIDw9IGxpbWl0KSBjaHVua3MucHVzaChjaHVuayk7XG4gICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoYCR7Y29tbWFuZH06IGNhcHR1cmVkIG91dHB1dCBleGNlZWRzICR7U3RyaW5nKGxpbWl0KX0gYnl0ZXNgKTtcbiAgICAgICAgICAgIGFib3J0KCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgY2hpbGQub25jZShcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgICAgICAgIGZhaWx1cmUgPz89IGVycm9yRnJvbShlcnJvcik7XG4gICAgICAgIH0pO1xuICAgICAgICBjaGlsZC5vbmNlKFwiY2xvc2VcIiwgKGNvZGUsIHNpZ25hbCkgPT4ge1xuICAgICAgICAgIGNvbnRyb2xsZXIuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCk7XG4gICAgICAgICAgaWYgKGVzY2FsYXRpb24pIGNsZWFyVGltZW91dChlc2NhbGF0aW9uKTtcbiAgICAgICAgICBpZiAobWlzc2luZyAmJiBpc1JlY29yZChmYWlsdXJlKSAmJiBmYWlsdXJlLmNvZGUgPT09IFwiRU5PRU5UXCIpIHJlc29sdmUodW5kZWZpbmVkKTtcbiAgICAgICAgICBlbHNlIGlmIChmYWlsdXJlKSByZWplY3QoZmFpbHVyZSk7XG4gICAgICAgICAgZWxzZSBpZiAoY29kZSAhPT0gMCkgcmVqZWN0KG5ldyBFcnJvcihgJHtjb21tYW5kfSBmYWlsZWQ6ICR7U3RyaW5nKGNvZGUgPz8gc2lnbmFsKX1gKSk7XG4gICAgICAgICAgZWxzZSByZXNvbHZlKEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0ZjhcIikudHJpbSgpKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghY2xlYW51cCkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSBhYm9ydCgpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBmYWlsdXJlczogdW5rbm93bltdID0gW107XG4gIGxldCByZXN1bHQ6IFQgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgLy8gTWlzc2luZyBleGVjdXRhYmxlcyBwcm9kdWNlIHVuZGVmaW5lZCBvbmx5IHdoZW4gdGhlIGNhbGxlciBleHBsaWNpdGx5IHBlcm1pdHMgdGhlbS5cbiAgICByZXN1bHQgPSBhd2FpdCBhY3Rpb24oc2NvcGUgYXMgTWFuYWdlZFByb2Nlc3NTY29wZSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZXMucHVzaChlcnJvcik7XG4gIH1cbiAgZm9yIChjb25zdCBjbGVhbnVwIG9mIGNsZWFudXBzLnJldmVyc2UoKSkge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjbGVhbnVwKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goZXJyb3IpO1xuICAgIH1cbiAgfVxuICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gIHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gIGlmIChmYWlsdXJlcy5sZW5ndGggPT09IDEpIHRocm93IGZhaWx1cmVzWzBdO1xuICBpZiAoZmFpbHVyZXMubGVuZ3RoKSB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoZmFpbHVyZXMsIGZhaWx1cmVzLm1hcCgoZXJyb3IpID0+IFN0cmluZyhlcnJvcikpLmpvaW4oXCI7IFwiKSk7XG4gIC8vIEEgY29tcGxldGVkIGFjdGlvbiBtYXkgaXRzZWxmIHJldHVybiB1bmRlZmluZWQ7IGEgZmFpbGVkIGFjdGlvbiB3YXMgdGhyb3duIGFib3ZlLlxuICByZXR1cm4gcmVzdWx0IGFzIFQ7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsaUJBQWlCO0FBa0JwQyxTQUFTLGFBQWE7QUFHdEIsZUFBc0IscUJBQXdCLFFBQW9FO0FBQ2hILFFBQU0sYUFBYSxJQUFJLGdCQUFnQjtBQUN2QyxRQUFNLFdBQThCLENBQUM7QUFDckMsUUFBTSxZQUFZLE1BQU07QUFDdEIsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDQSxVQUFRLEdBQUcsVUFBVSxTQUFTO0FBQzlCLFVBQVEsR0FBRyxXQUFXLFNBQVM7QUFDL0IsUUFBTSxRQUFRO0FBQUEsSUFDWixPQUFPLENBQUMsWUFBMkIsU0FBUyxLQUFLLE9BQU87QUFBQSxJQUN4RCxNQUFNLElBQ0osU0FDQSxNQUNBLEVBQUUsVUFBVSxPQUFPLFVBQVUsT0FBTyxVQUFVLE9BQU8sS0FBSyxLQUFLLFFBQVEsS0FBSyxPQUFPLEtBQUssSUFBdUIsQ0FBQyxHQUNoSDtBQUNBLFVBQUksQ0FBQyxRQUFTLFlBQVcsT0FBTyxlQUFlO0FBQy9DLGFBQU8sTUFBTSxJQUFJLFFBQTRCLENBQUMsU0FBUyxXQUFXO0FBQ2hFLGNBQU0sUUFBUSxNQUFNLFNBQVMsTUFBTTtBQUFBLFVBQ2pDO0FBQUEsVUFDQTtBQUFBLFVBQ0EsVUFBVSxRQUFRLGFBQWE7QUFBQSxVQUMvQixPQUFPLFVBQVUsQ0FBQyxVQUFVLFFBQVEsU0FBUyxJQUFJO0FBQUEsUUFDbkQsQ0FBQztBQUNELGNBQU0sU0FBbUIsQ0FBQztBQUMxQixZQUFJLE9BQU8sR0FDVCxTQUNBO0FBQ0YsY0FBTSxPQUFPLENBQUMsV0FBMkI7QUFDdkMsY0FBSSxDQUFDLE1BQU0sSUFBSztBQUNoQixjQUFJO0FBQ0YsZ0JBQUksUUFBUSxhQUFhLFFBQVMsT0FBTSxLQUFLLE1BQU07QUFBQSxnQkFDOUMsU0FBUSxLQUFLLENBQUMsTUFBTSxLQUFLLE1BQU07QUFBQSxVQUN0QyxTQUFTLE9BQU87QUFDZCxnQkFBSSxDQUFDLFNBQVMsS0FBSyxLQUFLLE1BQU0sU0FBUyxRQUFTLGFBQVksVUFBVSxLQUFLO0FBQUEsVUFDN0U7QUFBQSxRQUNGO0FBQ0EsY0FBTSxRQUFRLE1BQU07QUFDbEIsc0JBQVksSUFBSSxNQUFNLCtCQUErQjtBQUNyRCxlQUFLLFNBQVM7QUFDZCx5QkFBZSxXQUFXLE1BQU07QUFDOUIsaUJBQUssU0FBUztBQUFBLFVBQ2hCLEdBQUcsR0FBSTtBQUFBLFFBQ1Q7QUFDQSxjQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsVUFBa0I7QUFDMUMsa0JBQVEsTUFBTTtBQUNkLGNBQUksUUFBUSxNQUFPLFFBQU8sS0FBSyxLQUFLO0FBQUEsZUFDL0I7QUFDSCx3QkFBWSxJQUFJLE1BQU0sR0FBRyxPQUFPLDZCQUE2QixPQUFPLEtBQUssQ0FBQyxRQUFRO0FBQ2xGLGtCQUFNO0FBQUEsVUFDUjtBQUFBLFFBQ0YsQ0FBQztBQUNELGNBQU0sS0FBSyxTQUFTLENBQUMsVUFBVTtBQUM3QixzQkFBWSxVQUFVLEtBQUs7QUFBQSxRQUM3QixDQUFDO0FBQ0QsY0FBTSxLQUFLLFNBQVMsQ0FBQyxNQUFNLFdBQVc7QUFDcEMscUJBQVcsT0FBTyxvQkFBb0IsU0FBUyxLQUFLO0FBQ3BELGNBQUksV0FBWSxjQUFhLFVBQVU7QUFDdkMsY0FBSSxXQUFXLFNBQVMsT0FBTyxLQUFLLFFBQVEsU0FBUyxTQUFVLFNBQVEsTUFBUztBQUFBLG1CQUN2RSxRQUFTLFFBQU8sT0FBTztBQUFBLG1CQUN2QixTQUFTLEVBQUcsUUFBTyxJQUFJLE1BQU0sR0FBRyxPQUFPLFlBQVksT0FBTyxRQUFRLE1BQU0sQ0FBQyxFQUFFLENBQUM7QUFBQSxjQUNoRixTQUFRLE9BQU8sT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQUEsUUFDNUQsQ0FBQztBQUNELFlBQUksQ0FBQyxTQUFTO0FBQ1oscUJBQVcsT0FBTyxpQkFBaUIsU0FBUyxPQUFPLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFDakUsY0FBSSxXQUFXLE9BQU8sUUFBUyxPQUFNO0FBQUEsUUFDdkM7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUNBLFFBQU0sV0FBc0IsQ0FBQztBQUM3QixNQUFJO0FBQ0osTUFBSTtBQUVGLGFBQVMsTUFBTSxPQUFPLEtBQTRCO0FBQUEsRUFDcEQsU0FBUyxPQUFPO0FBQ2QsYUFBUyxLQUFLLEtBQUs7QUFBQSxFQUNyQjtBQUNBLGFBQVcsV0FBVyxTQUFTLFFBQVEsR0FBRztBQUN4QyxRQUFJO0FBQ0YsWUFBTSxRQUFRO0FBQUEsSUFDaEIsU0FBUyxPQUFPO0FBQ2QsZUFBUyxLQUFLLEtBQUs7QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFDQSxVQUFRLGVBQWUsVUFBVSxTQUFTO0FBQzFDLFVBQVEsZUFBZSxXQUFXLFNBQVM7QUFDM0MsTUFBSSxTQUFTLFdBQVcsRUFBRyxPQUFNLFNBQVMsQ0FBQztBQUMzQyxNQUFJLFNBQVMsT0FBUSxPQUFNLElBQUksZUFBZSxVQUFVLFNBQVMsSUFBSSxDQUFDLFVBQVUsT0FBTyxLQUFLLENBQUMsRUFBRSxLQUFLLElBQUksQ0FBQztBQUV6RyxTQUFPO0FBQ1Q7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9tYW5hZ2VkLXByb2Nlc3MubWpzIn0=
