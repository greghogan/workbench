// Generated from managed-process.mts; edit the TypeScript source.
import { isRecord, errorFrom } from "./values.mjs";
import { processFailure } from "./process-outcome.mjs";
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
          else {
            const problem = processFailure(
              command,
              { pid: child.pid ?? 0, status: code, signal, ...failure ? { error: failure } : {} },
              { stdout: Buffer.concat(chunks) }
            );
            if (problem) reject(problem);
            else resolve(Buffer.concat(chunks).toString("utf8").trim());
          }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtcHJvY2Vzcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNSZWNvcmQsIGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHByb2Nlc3NGYWlsdXJlIH0gZnJvbSBcIi4vcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuZXhwb3J0IGludGVyZmFjZSBNYW5hZ2VkUnVuT3B0aW9ucyB7XG4gIGNhcHR1cmU/OiBib29sZWFuO1xuICBjbGVhbnVwPzogYm9vbGVhbjtcbiAgbWlzc2luZz86IGJvb2xlYW47XG4gIGN3ZD86IHN0cmluZztcbiAgZW52PzogTm9kZUpTLlByb2Nlc3NFbnY7XG4gIGxpbWl0PzogbnVtYmVyO1xufVxuZXhwb3J0IGludGVyZmFjZSBNYW5hZ2VkUHJvY2Vzc1Njb3BlIHtcbiAgZGVmZXIoY2xlYW51cDogKCkgPT4gdW5rbm93bik6IHZvaWQ7XG4gIHJ1bihcbiAgICBjb21tYW5kOiBzdHJpbmcsXG4gICAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gICAgb3B0aW9uczogTWFuYWdlZFJ1bk9wdGlvbnMgJiB7IG1pc3Npbmc6IHRydWUgfSxcbiAgKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgb3B0aW9ucz86IE1hbmFnZWRSdW5PcHRpb25zICYgeyBtaXNzaW5nPzogZmFsc2UgfSk6IFByb21pc2U8c3RyaW5nPjtcbn1cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuXG4vKiogUHJlcGFyYXRpb24gb3ducyBjaGlsZHJlbiB1bnRpbCBleGl0IGFuZCBhdHRlbXB0cyBldmVyeSByZWdpc3RlcmVkIGNsZWFudXAsIGluY2x1ZGluZyBhZnRlciBjYW5jZWxsYXRpb24uICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aE1hbmFnZWRQcm9jZXNzZXM8VD4oYWN0aW9uOiAoc2NvcGU6IE1hbmFnZWRQcm9jZXNzU2NvcGUpID0+IFQgfCBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IGNsZWFudXBzOiAoKCkgPT4gdW5rbm93bilbXSA9IFtdO1xuICBjb25zdCBpbnRlcnJ1cHQgPSAoKSA9PiB7XG4gICAgY29udHJvbGxlci5hYm9ydCgpO1xuICB9O1xuICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gIGNvbnN0IHNjb3BlID0ge1xuICAgIGRlZmVyOiAoY2xlYW51cDogKCkgPT4gdW5rbm93bikgPT4gY2xlYW51cHMucHVzaChjbGVhbnVwKSxcbiAgICBhc3luYyBydW4oXG4gICAgICBjb21tYW5kOiBzdHJpbmcsXG4gICAgICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgICAgIHsgY2FwdHVyZSA9IGZhbHNlLCBjbGVhbnVwID0gZmFsc2UsIG1pc3NpbmcgPSBmYWxzZSwgY3dkLCBlbnYsIGxpbWl0ID0gMTYgKiAxMDI0ICogMTAyNCB9OiBNYW5hZ2VkUnVuT3B0aW9ucyA9IHt9LFxuICAgICkge1xuICAgICAgaWYgKCFjbGVhbnVwKSBjb250cm9sbGVyLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCBjaGlsZCA9IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICAgICAgICBjd2QsXG4gICAgICAgICAgZW52LFxuICAgICAgICAgIGRldGFjaGVkOiBwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIsXG4gICAgICAgICAgc3RkaW86IGNhcHR1cmUgPyBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaW5oZXJpdFwiXSA6IFwiaW5oZXJpdFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgICAgICBsZXQgc2l6ZSA9IDAsXG4gICAgICAgICAgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQsXG4gICAgICAgICAgZXNjYWxhdGlvbjogTm9kZUpTLlRpbWVvdXQgfCB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IHN0b3AgPSAoc2lnbmFsOiBOb2RlSlMuU2lnbmFscykgPT4ge1xuICAgICAgICAgIGlmICghY2hpbGQucGlkKSByZXR1cm47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIGNoaWxkLmtpbGwoc2lnbmFsKTtcbiAgICAgICAgICAgIGVsc2UgcHJvY2Vzcy5raWxsKC1jaGlsZC5waWQsIHNpZ25hbCk7XG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmICghaXNSZWNvcmQoZXJyb3IpIHx8IGVycm9yLmNvZGUgIT09IFwiRVNSQ0hcIikgZmFpbHVyZSA/Pz0gZXJyb3JGcm9tKGVycm9yKTtcbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IGFib3J0ID0gKCkgPT4ge1xuICAgICAgICAgIGZhaWx1cmUgPz89IG5ldyBFcnJvcihcIk1hbmFnZWQgcHJlcGFyYXRpb24gY2FuY2VsbGVkXCIpO1xuICAgICAgICAgIHN0b3AoXCJTSUdURVJNXCIpO1xuICAgICAgICAgIGVzY2FsYXRpb24gPz89IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgICAgICAgfSwgMjAwMCk7XG4gICAgICAgIH07XG4gICAgICAgIGNoaWxkLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICAgICAgc2l6ZSArPSBjaHVuay5sZW5ndGg7XG4gICAgICAgICAgaWYgKHNpemUgPD0gbGltaXQpIGNodW5rcy5wdXNoKGNodW5rKTtcbiAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGZhaWx1cmUgPz89IG5ldyBFcnJvcihgJHtjb21tYW5kfTogY2FwdHVyZWQgb3V0cHV0IGV4Y2VlZHMgJHtTdHJpbmcobGltaXQpfSBieXRlc2ApO1xuICAgICAgICAgICAgYWJvcnQoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBjaGlsZC5vbmNlKFwiZXJyb3JcIiwgKGVycm9yKSA9PiB7XG4gICAgICAgICAgZmFpbHVyZSA/Pz0gZXJyb3JGcm9tKGVycm9yKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNoaWxkLm9uY2UoXCJjbG9zZVwiLCAoY29kZSwgc2lnbmFsKSA9PiB7XG4gICAgICAgICAgY29udHJvbGxlci5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0KTtcbiAgICAgICAgICBpZiAoZXNjYWxhdGlvbikgY2xlYXJUaW1lb3V0KGVzY2FsYXRpb24pO1xuICAgICAgICAgIGlmIChtaXNzaW5nICYmIGlzUmVjb3JkKGZhaWx1cmUpICYmIGZhaWx1cmUuY29kZSA9PT0gXCJFTk9FTlRcIikgcmVzb2x2ZSh1bmRlZmluZWQpO1xuICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgcHJvYmxlbSA9IHByb2Nlc3NGYWlsdXJlKFxuICAgICAgICAgICAgICBjb21tYW5kLFxuICAgICAgICAgICAgICB7IHBpZDogY2hpbGQucGlkID8/IDAsIHN0YXR1czogY29kZSwgc2lnbmFsLCAuLi4oZmFpbHVyZSA/IHsgZXJyb3I6IGZhaWx1cmUgfSA6IHt9KSB9LFxuICAgICAgICAgICAgICB7IHN0ZG91dDogQnVmZmVyLmNvbmNhdChjaHVua3MpIH0sXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHByb2JsZW0pIHJlamVjdChwcm9ibGVtKTtcbiAgICAgICAgICAgIGVsc2UgcmVzb2x2ZShCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFjbGVhbnVwKSB7XG4gICAgICAgICAgY29udHJvbGxlci5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIGFib3J0KCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG4gIGNvbnN0IGZhaWx1cmVzOiB1bmtub3duW10gPSBbXTtcbiAgbGV0IHJlc3VsdDogVCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICAvLyBNaXNzaW5nIGV4ZWN1dGFibGVzIHByb2R1Y2UgdW5kZWZpbmVkIG9ubHkgd2hlbiB0aGUgY2FsbGVyIGV4cGxpY2l0bHkgcGVybWl0cyB0aGVtLlxuICAgIHJlc3VsdCA9IGF3YWl0IGFjdGlvbihzY29wZSBhcyBNYW5hZ2VkUHJvY2Vzc1Njb3BlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsdXJlcy5wdXNoKGVycm9yKTtcbiAgfVxuICBmb3IgKGNvbnN0IGNsZWFudXAgb2YgY2xlYW51cHMucmV2ZXJzZSgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNsZWFudXAoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgZmFpbHVyZXMucHVzaChlcnJvcik7XG4gICAgfVxuICB9XG4gIHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoXCJTSUdJTlRcIiwgaW50ZXJydXB0KTtcbiAgcHJvY2Vzcy5yZW1vdmVMaXN0ZW5lcihcIlNJR1RFUk1cIiwgaW50ZXJydXB0KTtcbiAgaWYgKGZhaWx1cmVzLmxlbmd0aCA9PT0gMSkgdGhyb3cgZmFpbHVyZXNbMF07XG4gIGlmIChmYWlsdXJlcy5sZW5ndGgpIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihmYWlsdXJlcywgZmFpbHVyZXMubWFwKChlcnJvcikgPT4gU3RyaW5nKGVycm9yKSkuam9pbihcIjsgXCIpKTtcbiAgLy8gQSBjb21wbGV0ZWQgYWN0aW9uIG1heSBpdHNlbGYgcmV0dXJuIHVuZGVmaW5lZDsgYSBmYWlsZWQgYWN0aW9uIHdhcyB0aHJvd24gYWJvdmUuXG4gIHJldHVybiByZXN1bHQgYXMgVDtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxpQkFBaUI7QUFDcEMsU0FBUyxzQkFBc0I7QUFrQi9CLFNBQVMsYUFBYTtBQUd0QixlQUFzQixxQkFBd0IsUUFBb0U7QUFDaEgsUUFBTSxhQUFhLElBQUksZ0JBQWdCO0FBQ3ZDLFFBQU0sV0FBOEIsQ0FBQztBQUNyQyxRQUFNLFlBQVksTUFBTTtBQUN0QixlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNBLFVBQVEsR0FBRyxVQUFVLFNBQVM7QUFDOUIsVUFBUSxHQUFHLFdBQVcsU0FBUztBQUMvQixRQUFNLFFBQVE7QUFBQSxJQUNaLE9BQU8sQ0FBQyxZQUEyQixTQUFTLEtBQUssT0FBTztBQUFBLElBQ3hELE1BQU0sSUFDSixTQUNBLE1BQ0EsRUFBRSxVQUFVLE9BQU8sVUFBVSxPQUFPLFVBQVUsT0FBTyxLQUFLLEtBQUssUUFBUSxLQUFLLE9BQU8sS0FBSyxJQUF1QixDQUFDLEdBQ2hIO0FBQ0EsVUFBSSxDQUFDLFFBQVMsWUFBVyxPQUFPLGVBQWU7QUFDL0MsYUFBTyxNQUFNLElBQUksUUFBNEIsQ0FBQyxTQUFTLFdBQVc7QUFDaEUsY0FBTSxRQUFRLE1BQU0sU0FBUyxNQUFNO0FBQUEsVUFDakM7QUFBQSxVQUNBO0FBQUEsVUFDQSxVQUFVLFFBQVEsYUFBYTtBQUFBLFVBQy9CLE9BQU8sVUFBVSxDQUFDLFVBQVUsUUFBUSxTQUFTLElBQUk7QUFBQSxRQUNuRCxDQUFDO0FBQ0QsY0FBTSxTQUFtQixDQUFDO0FBQzFCLFlBQUksT0FBTyxHQUNULFNBQ0E7QUFDRixjQUFNLE9BQU8sQ0FBQyxXQUEyQjtBQUN2QyxjQUFJLENBQUMsTUFBTSxJ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
