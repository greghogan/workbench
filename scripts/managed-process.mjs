// Generated from managed-process.mts; edit the TypeScript source.
import { isRecord } from "./values.mjs";
import { runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
async function withManagedProcesses(action) {
  const controller = new AbortController();
  const cleanups = [];
  const ownership = { uncertain: false };
  const interrupt = () => {
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const scope = {
    defer: (action2, kind = "release") => cleanups.push({ action: action2, kind }),
    async run(command, args, { capture = false, cleanup = false, missing = false, cwd, env, limit = 16 * 1024 * 1024 } = {}) {
      if (!cleanup) controller.signal.throwIfAborted();
      const captureController = new AbortController();
      const signal = cleanup ? captureController.signal : AbortSignal.any([controller.signal, captureController.signal]);
      const chunks = [];
      let size = 0, failure;
      const outcome = await runOwnedChild(command, [...args], {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
        signal,
        inheritInput: !capture,
        stopDescendantsOnExit: true,
        ...capture ? {
          output: (stdout, stderr) => {
            stderr.pipe(process.stderr, { end: false });
            stdout.on("data", (chunk) => {
              size += chunk.length;
              if (size <= limit) chunks.push(chunk);
              else {
                failure ??= new Error(`${command}: captured output exceeds ${String(limit)} bytes`);
                captureController.abort(failure);
              }
            });
          }
        } : { inheritOutput: true }
      }).catch((error) => {
        if (missing && isRecord(error) && error.code === "ENOENT") return void 0;
        ownership.uncertain ||= !(isRecord(error) && error.code === "ENOENT");
        throw error;
      });
      if (outcome === void 0) return void 0;
      ownership.uncertain ||= outcome.descendantsActive === true;
      if (missing && isRecord(outcome.error) && outcome.error.code === "ENOENT") return void 0;
      if (!cleanup && controller.signal.aborted) failure ??= new Error("Managed preparation cancelled");
      const problem = processFailure(
        command,
        { ...outcome, ...failure ? { error: failure } : {} },
        {
          stdout: Buffer.concat(chunks)
        }
      );
      if (problem) throw problem;
      return Buffer.concat(chunks).toString("utf8").trim();
    }
  };
  const failures = [];
  let result;
  try {
    result = await action(scope);
  } catch (error) {
    failures.push(error);
  }
  if (ownership.uncertain) failures.push(new Error("Child termination is uncertain; preserving preparation resources"));
  for (const cleanup of cleanups.reverse()) {
    if (ownership.uncertain && cleanup.kind === "release") continue;
    try {
      await cleanup.action();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtcHJvY2Vzcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNSZWNvcmQgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBydW5Pd25lZENoaWxkIH0gZnJvbSBcIi4vb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBwcm9jZXNzRmFpbHVyZSB9IGZyb20gXCIuL3Byb2Nlc3Mtb3V0Y29tZS5tanNcIjtcbmV4cG9ydCBpbnRlcmZhY2UgTWFuYWdlZFJ1bk9wdGlvbnMge1xuICBjYXB0dXJlPzogYm9vbGVhbjtcbiAgY2xlYW51cD86IGJvb2xlYW47XG4gIG1pc3Npbmc/OiBib29sZWFuO1xuICBjd2Q/OiBzdHJpbmc7XG4gIGVudj86IE5vZGVKUy5Qcm9jZXNzRW52O1xuICBsaW1pdD86IG51bWJlcjtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgTWFuYWdlZFByb2Nlc3NTY29wZSB7XG4gIGRlZmVyKGNsZWFudXA6ICgpID0+IHVua25vd24sIGtpbmQ/OiBcInJlbGVhc2VcIiB8IFwic2h1dGRvd25cIik6IHZvaWQ7XG4gIHJ1bihcbiAgICBjb21tYW5kOiBzdHJpbmcsXG4gICAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gICAgb3B0aW9uczogTWFuYWdlZFJ1bk9wdGlvbnMgJiB7IG1pc3Npbmc6IHRydWUgfSxcbiAgKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgb3B0aW9ucz86IE1hbmFnZWRSdW5PcHRpb25zICYgeyBtaXNzaW5nPzogZmFsc2UgfSk6IFByb21pc2U8c3RyaW5nPjtcbn1cblxuLyoqIFByZXBhcmF0aW9uIG93bnMgY2hpbGRyZW4gdW50aWwgZXhpdCBhbmQgYXR0ZW1wdHMgZXZlcnkgcmVnaXN0ZXJlZCBjbGVhbnVwLCBpbmNsdWRpbmcgYWZ0ZXIgY2FuY2VsbGF0aW9uLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhNYW5hZ2VkUHJvY2Vzc2VzPFQ+KGFjdGlvbjogKHNjb3BlOiBNYW5hZ2VkUHJvY2Vzc1Njb3BlKSA9PiBUIHwgUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBjbGVhbnVwczogeyBhY3Rpb246ICgpID0+IHVua25vd247IGtpbmQ6IFwicmVsZWFzZVwiIHwgXCJzaHV0ZG93blwiIH1bXSA9IFtdO1xuICBjb25zdCBvd25lcnNoaXAgPSB7IHVuY2VydGFpbjogZmFsc2UgfTtcbiAgY29uc3QgaW50ZXJydXB0ID0gKCkgPT4ge1xuICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgfTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICBjb25zdCBzY29wZSA9IHtcbiAgICBkZWZlcjogKGFjdGlvbjogKCkgPT4gdW5rbm93biwga2luZDogXCJyZWxlYXNlXCIgfCBcInNodXRkb3duXCIgPSBcInJlbGVhc2VcIikgPT4gY2xlYW51cHMucHVzaCh7IGFjdGlvbiwga2luZCB9KSxcbiAgICBhc3luYyBydW4oXG4gICAgICBjb21tYW5kOiBzdHJpbmcsXG4gICAgICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgICAgIHsgY2FwdHVyZSA9IGZhbHNlLCBjbGVhbnVwID0gZmFsc2UsIG1pc3NpbmcgPSBmYWxzZSwgY3dkLCBlbnYsIGxpbWl0ID0gMTYgKiAxMDI0ICogMTAyNCB9OiBNYW5hZ2VkUnVuT3B0aW9ucyA9IHt9LFxuICAgICkge1xuICAgICAgaWYgKCFjbGVhbnVwKSBjb250cm9sbGVyLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgY29uc3QgY2FwdHVyZUNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBzaWduYWwgPSBjbGVhbnVwXG4gICAgICAgID8gY2FwdHVyZUNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgIDogQWJvcnRTaWduYWwuYW55KFtjb250cm9sbGVyLnNpZ25hbCwgY2FwdHVyZUNvbnRyb2xsZXIuc2lnbmFsXSk7XG4gICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgICBsZXQgc2l6ZSA9IDAsXG4gICAgICAgIGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkO1xuICAgICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgWy4uLmFyZ3NdLCB7XG4gICAgICAgIGN3ZDogY3dkID8/IHByb2Nlc3MuY3dkKCksXG4gICAgICAgIGVudjogZW52ID8/IHByb2Nlc3MuZW52LFxuICAgICAgICBzaWduYWwsXG4gICAgICAgIGluaGVyaXRJbnB1dDogIWNhcHR1cmUsXG4gICAgICAgIHN0b3BEZXNjZW5kYW50c09uRXhpdDogdHJ1ZSxcbiAgICAgICAgLi4uKGNhcHR1cmVcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgb3V0cHV0OiAoc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgICAgICAgICBzdGRlcnIucGlwZShwcm9jZXNzLnN0ZGVyciwgeyBlbmQ6IGZhbHNlIH0pO1xuICAgICAgICAgICAgICAgIHN0ZG91dC5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IHtcbiAgICAgICAgICAgICAgICAgIHNpemUgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgICAgICAgICAgaWYgKHNpemUgPD0gbGltaXQpIGNodW5rcy5wdXNoKGNodW5rKTtcbiAgICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoYCR7Y29tbWFuZH06IGNhcHR1cmVkIG91dHB1dCBleGNlZWRzICR7U3RyaW5nKGxpbWl0KX0gYnl0ZXNgKTtcbiAgICAgICAgICAgICAgICAgICAgY2FwdHVyZUNvbnRyb2xsZXIuYWJvcnQoZmFpbHVyZSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB7IGluaGVyaXRPdXRwdXQ6IHRydWUgfSksXG4gICAgICB9KS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICAgICAgaWYgKG1pc3NpbmcgJiYgaXNSZWNvcmQoZXJyb3IpICYmIGVycm9yLmNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIG93bmVyc2hpcC51bmNlcnRhaW4gfHw9ICEoaXNSZWNvcmQoZXJyb3IpICYmIGVycm9yLmNvZGUgPT09IFwiRU5PRU5UXCIpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICAgICAgaWYgKG91dGNvbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIG93bmVyc2hpcC51bmNlcnRhaW4gfHw9IG91dGNvbWUuZGVzY2VuZGFudHNBY3RpdmUgPT09IHRydWU7XG4gICAgICBpZiAobWlzc2luZyAmJiBpc1JlY29yZChvdXRjb21lLmVycm9yKSAmJiBvdXRjb21lLmVycm9yLmNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAoIWNsZWFudXAgJiYgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgZmFpbHVyZSA/Pz0gbmV3IEVycm9yKFwiTWFuYWdlZCBwcmVwYXJhdGlvbiBjYW5jZWxsZWRcIik7XG4gICAgICBjb25zdCBwcm9ibGVtID0gcHJvY2Vzc0ZhaWx1cmUoXG4gICAgICAgIGNvbW1hbmQsXG4gICAgICAgIHsgLi4ub3V0Y29tZSwgLi4uKGZhaWx1cmUgPyB7IGVycm9yOiBmYWlsdXJlIH0gOiB7fSkgfSxcbiAgICAgICAge1xuICAgICAgICAgIHN0ZG91dDogQnVmZmVyLmNvbmNhdChjaHVua3MpLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICAgIGlmIChwcm9ibGVtKSB0aHJvdyBwcm9ibGVtO1xuICAgICAgcmV0dXJuIEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0ZjhcIikudHJpbSgpO1xuICAgIH0sXG4gIH07XG4gIGNvbnN0IGZhaWx1cmVzOiB1bmtub3duW10gPSBbXTtcbiAgbGV0IHJlc3VsdDogVCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICAvLyBNaXNzaW5nIGV4ZWN1dGFibGVzIHByb2R1Y2UgdW5kZWZpbmVkIG9ubHkgd2hlbiB0aGUgY2FsbGVyIGV4cGxpY2l0bHkgcGVybWl0cyB0aGVtLlxuICAgIHJlc3VsdCA9IGF3YWl0IGFjdGlvbihzY29wZSBhcyBNYW5hZ2VkUHJvY2Vzc1Njb3BlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsdXJlcy5wdXNoKGVycm9yKTtcbiAgfVxuICBpZiAob3duZXJzaGlwLnVuY2VydGFpbikgZmFpbHVyZXMucHVzaChuZXcgRXJyb3IoXCJDaGlsZCB0ZXJtaW5hdGlvbiBpcyB1bmNlcnRhaW47IHByZXNlcnZpbmcgcHJlcGFyYXRpb24gcmVzb3VyY2VzXCIpKTtcbiAgZm9yIChjb25zdCBjbGVhbnVwIG9mIGNsZWFudXBzLnJldmVyc2UoKSkge1xuICAgIGlmIChvd25lcnNoaXAudW5jZXJ0YWluICYmIGNsZWFudXAua2luZCA9PT0gXCJyZWxlYXNlXCIpIGNvbnRpbnVlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjbGVhbnVwLmFjdGlvbigpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsdXJlcy5wdXNoKGVycm9yKTtcbiAgICB9XG4gIH1cbiAgcHJvY2Vzcy5yZW1vdmVMaXN0ZW5lcihcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICBpZiAoZmFpbHVyZXMubGVuZ3RoID09PSAxKSB0aHJvdyBmYWlsdXJlc1swXTtcbiAgaWYgKGZhaWx1cmVzLmxlbmd0aCkgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGZhaWx1cmVzLCBmYWlsdXJlcy5tYXAoKGVycm9yKSA9PiBTdHJpbmcoZXJyb3IpKS5qb2luKFwiOyBcIikpO1xuICAvLyBBIGNvbXBsZXRlZCBhY3Rpb24gbWF5IGl0c2VsZiByZXR1cm4gdW5kZWZpbmVkOyBhIGZhaWxlZCBhY3Rpb24gd2FzIHRocm93biBhYm92ZS5cbiAgcmV0dXJuIHJlc3VsdCBhcyBUO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxzQkFBc0I7QUFvQi9CLGVBQXNCLHFCQUF3QixRQUFvRTtBQUNoSCxRQUFNLGFBQWEsSUFBSSxnQkFBZ0I7QUFDdkMsUUFBTSxXQUFzRSxDQUFDO0FBQzdFLFFBQU0sWUFBWSxFQUFFLFdBQVcsTUFBTTtBQUNyQyxRQUFNLFlBQVksTUFBTTtBQUN0QixlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNBLFVBQVEsR0FBRyxVQUFVLFNBQVM7QUFDOUIsVUFBUSxHQUFHLFdBQVcsU0FBUztBQUMvQixRQUFNLFFBQVE7QUFBQSxJQUNaLE9BQU8sQ0FBQ0EsU0FBdUIsT0FBK0IsY0FBYyxTQUFTLEtBQUssRUFBRSxRQUFBQSxTQUFRLEtBQUssQ0FBQztBQUFBLElBQzFHLE1BQU0sSUFDSixTQUNBLE1BQ0EsRUFBRSxVQUFVLE9BQU8sVUFBVSxPQUFPLFVBQVUsT0FBTyxLQUFLLEtBQUssUUFBUSxLQUFLLE9BQU8sS0FBSyxJQUF1QixDQUFDLEdBQ2hIO0FBQ0EsVUFBSSxDQUFDLFFBQVMsWUFBVyxPQUFPLGVBQWU7QUFDL0MsWUFBTSxvQkFBb0IsSUFBSSxnQkFBZ0I7QUFDOUMsWUFBTSxTQUFTLFVBQ1gsa0JBQWtCLFNBQ2xCLFlBQVksSUFBSSxDQUFDLFdBQVcsUUFBUSxrQkFBa0IsTUFBTSxDQUFDO0FBQ2pFLFlBQU0sU0FBbUIsQ0FBQztBQUMxQixVQUFJLE9BQU8sR0FDVDtBQUNGLFlBQU0sVUFBVSxNQUFN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
