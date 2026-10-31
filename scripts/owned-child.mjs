// Generated from owned-child.mts; edit the TypeScript source.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
function processCancellation() {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    close: () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  };
}
async function runOwnedChild(command, args, options) {
  options.signal.throwIfAborted();
  if (options.input !== void 0 && options.inheritInput)
    throw new Error("Child input must be supplied or inherited, not both");
  options.owner?.beforeSpawn();
  const cancelling = options.shutdown !== "drain";
  let child;
  try {
    const settings = {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false
    };
    child = options.input !== void 0 ? spawn(command, args, { ...settings, stdio: ["pipe", "pipe", "pipe"] }) : spawn(command, args, { ...settings, stdio: [options.inheritInput ? "inherit" : "ignore", "pipe", "pipe"] });
  } catch (error) {
    options.owner?.spawned(void 0, false);
    throw error;
  }
  let failure;
  const killing = [];
  const stop = (signal) => {
    if (child.pid === void 0) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else
        killing.push(
          new Promise((resolve) => {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore"
            });
            killer.on("error", (error) => {
              failure ??= error;
            });
            killer.on("close", () => {
              resolve();
            });
          })
        );
    } catch (error) {
      if (error.code !== "ESRCH")
        failure ??= error instanceof Error ? error : new Error("Child termination failed", { cause: error });
    }
  };
  const timers = [];
  const abort = () => {
    stop("SIGINT");
    timers.push(
      setTimeout(() => {
        stop("SIGTERM");
      }, 5e3),
      setTimeout(() => {
        stop("SIGKILL");
      }, 1e4)
    );
  };
  child.on("error", (error) => {
    failure ??= error;
  });
  child.stdin?.on("error", (error) => {
    failure ??= error;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => {
      resolve({ pid: child.pid ?? 0, status, signal });
    });
  });
  let completed;
  try {
    completed = options.owner?.spawned(child.pid, process.platform !== "win32");
  } catch (error) {
    stop("SIGKILL");
    await closed;
    throw error;
  }
  try {
    try {
      if (options.output) options.output(child.stdout, child.stderr);
      else {
        child.stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Child output setup failed", { cause: error });
      child.stdout.resume();
      child.stderr.resume();
      stop("SIGKILL");
    }
    if (cancelling) {
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
    if (options.input !== void 0) child.stdin?.end(options.input);
    const outcome = await closed;
    if (cancelling && options.signal.aborted) stop("SIGKILL");
    await Promise.all(killing);
    if (process.platform !== "win32" && child.pid !== void 0) {
      const deadline = Date.now() + 5e3;
      for (; ; ) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) {
          failure ??= new Error("Child descendants remain active; preserving owned scratch");
          break;
        }
        await delay(10);
      }
    }
    try {
      completed?.();
    } catch (cause) {
      const ownership = cause instanceof Error ? cause : new Error("Child ownership update failed", { cause });
      failure = failure ? new AggregateError([failure, ownership], "Child execution and ownership update failed", { cause: failure }) : ownership;
    }
    return { ...outcome, ...failure ? { error: failure } : {} };
  } finally {
    options.signal.removeEventListener("abort", abort);
    for (const timer of timers) clearTimeout(timer);
  }
}
async function captureOwnedChild(command, args, options, limit = 1024 * 1024) {
  const stdout = [], stderr = [];
  let bytes = 0;
  const outcome = await runOwnedChild(command, args, {
    ...options,
    output: (out, err) => {
      for (const [stream, chunks] of [
        [out, stdout],
        [err, stderr]
      ])
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= limit) chunks.push(chunk);
        });
    }
  });
  return {
    ...outcome,
    ...bytes > limit ? { error: new Error(`Captured command output exceeds ${String(limit)} bytes`) } : {},
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  };
}
export {
  captureOwnedChild,
  processCancellation,
  runOwnedChild
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm93bmVkLWNoaWxkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NCeVN0ZGlvIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSwgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgZGVsYXkgfSBmcm9tIFwibm9kZTp0aW1lcnMvcHJvbWlzZXNcIjtcbmltcG9ydCB0eXBlIHsgUHJvY2Vzc0xvY2sgfSBmcm9tIFwiLi4vc3JjL3Byb2Nlc3MtbG9jay5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENoaWxkT3V0Y29tZSB7XG4gIHBpZDogbnVtYmVyO1xuICBzdGF0dXM6IG51bWJlciB8IG51bGw7XG4gIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsO1xuICBlcnJvcj86IEVycm9yO1xufVxuZXhwb3J0IGludGVyZmFjZSBPd25lZENoaWxkT3B0aW9ucyB7XG4gIGN3ZDogc3RyaW5nO1xuICBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52O1xuICBzaWduYWw6IEFib3J0U2lnbmFsO1xuICBvd25lcj86IFByb2Nlc3NMb2NrO1xuICBpbnB1dD86IHN0cmluZztcbiAgaW5oZXJpdElucHV0PzogYm9vbGVhbjtcbiAgc2h1dGRvd24/OiBcImNhbmNlbFwiIHwgXCJkcmFpblwiO1xuICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM/OiBib29sZWFuO1xuICBvdXRwdXQ/OiAoc3Rkb3V0OiBSZWFkYWJsZSwgc3RkZXJyOiBSZWFkYWJsZSkgPT4gdm9pZDtcbn1cbmV4cG9ydCBmdW5jdGlvbiBwcm9jZXNzQ2FuY2VsbGF0aW9uKCkge1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBpbnRlcnJ1cHQgPSAoKSA9PiB7XG4gICAgY29udHJvbGxlci5hYm9ydCgpO1xuICB9O1xuICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gIHJldHVybiB7XG4gICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICBjbG9zZTogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgaW50ZXJydXB0KTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKiBPd24gdGhlIGNvbXBsZXRlIGNoaWxkIGdyb3VwIHRocm91Z2ggY2FuY2VsbGF0aW9uIGFuZCByZWFwaW5nLCBiZWZvcmUgaXRzIHNjcmF0Y2ggZGF0YSBjYW4gYmUgcmVsZWFzZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuT3duZWRDaGlsZChcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogT3duZWRDaGlsZE9wdGlvbnMsXG4pOiBQcm9taXNlPENoaWxkT3V0Y29tZT4ge1xuICBvcHRpb25zLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICBpZiAob3B0aW9ucy5pbnB1dCAhPT0gdW5kZWZpbmVkICYmIG9wdGlvbnMuaW5oZXJpdElucHV0KVxuICAgIHRocm93IG5ldyBFcnJvcihcIkNoaWxkIGlucHV0IG11c3QgYmUgc3VwcGxpZWQgb3IgaW5oZXJpdGVkLCBub3QgYm90aFwiKTtcbiAgb3B0aW9ucy5vd25lcj8uYmVmb3JlU3Bhd24oKTtcbiAgY29uc3QgY2FuY2VsbGluZyA9IG9wdGlvbnMuc2h1dGRvd24gIT09IFwiZHJhaW5cIjtcbiAgbGV0IGNoaWxkOiBDaGlsZFByb2Nlc3NCeVN0ZGlvPFdyaXRhYmxlIHwgbnVsbCwgUmVhZGFibGUsIFJlYWRhYmxlPjtcbiAgdHJ5IHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IHtcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgZGV0YWNoZWQ6IHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIixcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiBvcHRpb25zLndpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyA/PyBmYWxzZSxcbiAgICB9O1xuICAgIGNoaWxkID1cbiAgICAgIG9wdGlvbnMuaW5wdXQgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0gfSlcbiAgICAgICAgOiBzcGF3bihjb21tYW5kLCBhcmdzLCB7IC4uLnNldHRpbmdzLCBzdGRpbzogW29wdGlvbnMuaW5oZXJpdElucHV0ID8gXCJpbmhlcml0XCIgOiBcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIG9wdGlvbnMub3duZXI/LnNwYXduZWQodW5kZWZpbmVkLCBmYWxzZSk7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgbGV0IGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkO1xuICBjb25zdCBraWxsaW5nOiBQcm9taXNlPHZvaWQ+W10gPSBbXTtcbiAgY29uc3Qgc3RvcCA9IChzaWduYWw6IE5vZGVKUy5TaWduYWxzKSA9PiB7XG4gICAgaWYgKGNoaWxkLnBpZCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIpIHByb2Nlc3Mua2lsbCgtY2hpbGQucGlkLCBzaWduYWwpO1xuICAgICAgZWxzZVxuICAgICAgICBraWxsaW5nLnB1c2goXG4gICAgICAgICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGtpbGxlciA9IHNwYXduKFwidGFza2tpbGxcIiwgW1wiL1BJRFwiLCBTdHJpbmcoY2hpbGQucGlkKSwgXCIvVFwiLCBcIi9GXCJdLCB7XG4gICAgICAgICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgICAgICAgICBzdGRpbzogXCJpZ25vcmVcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAga2lsbGVyLm9uKFwiZXJyb3JcIiwgKGVycm9yKSA9PiB7XG4gICAgICAgICAgICAgIGZhaWx1cmUgPz89IGVycm9yO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBraWxsZXIub24oXCJjbG9zZVwiLCAoKSA9PiB7XG4gICAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pLFxuICAgICAgICApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSAhPT0gXCJFU1JDSFwiKVxuICAgICAgICBmYWlsdXJlID8/PSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDaGlsZCB0ZXJtaW5hdGlvbiBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSk7XG4gICAgfVxuICB9O1xuICBjb25zdCB0aW1lcnM6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+W10gPSBbXTtcbiAgY29uc3QgYWJvcnQgPSAoKSA9PiB7XG4gICAgc3RvcChcIlNJR0lOVFwiKTtcbiAgICB0aW1lcnMucHVzaChcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBzdG9wKFwiU0lHVEVSTVwiKTtcbiAgICAgIH0sIDUwMDApLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgICAgfSwgMTAwMDApLFxuICAgICk7XG4gIH07XG4gIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycm9yKSA9PiB7XG4gICAgZmFpbHVyZSA/Pz0gZXJyb3I7XG4gIH0pO1xuICBjaGlsZC5zdGRpbj8ub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IHtcbiAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgfSk7XG4gIGNvbnN0IGNsb3NlZCA9IG5ldyBQcm9taXNlPENoaWxkT3V0Y29tZT4oKHJlc29sdmUpID0+IHtcbiAgICBjaGlsZC5vbmNlKFwiY2xvc2VcIiwgKHN0YXR1cywgc2lnbmFsKSA9PiB7XG4gICAgICByZXNvbHZlKHsgcGlkOiBjaGlsZC5waWQgPz8gMCwgc3RhdHVzLCBzaWduYWwgfSk7XG4gICAgfSk7XG4gIH0pO1xuICBsZXQgY29tcGxldGVkOiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgY29tcGxldGVkID0gb3B0aW9ucy5vd25lcj8uc3Bhd25lZChjaGlsZC5waWQsIHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIik7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgYXdhaXQgY2xvc2VkO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIHRyeSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChvcHRpb25zLm91dHB1dCkgb3B0aW9ucy5vdXRwdXQoY2hpbGQuc3Rkb3V0LCBjaGlsZC5zdGRlcnIpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGNoaWxkLnN0ZG91dC5waXBlKHByb2Nlc3Muc3Rkb3V0LCB7IGVuZDogZmFsc2UgfSk7XG4gICAgICAgIGNoaWxkLnN0ZGVyci5waXBlKHByb2Nlc3Muc3RkZXJyLCB7IGVuZDogZmFsc2UgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWx1cmUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDaGlsZCBvdXRwdXQgc2V0dXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgICAgY2hpbGQuc3Rkb3V0LnJlc3VtZSgpO1xuICAgICAgY2hpbGQuc3RkZXJyLnJlc3VtZSgpO1xuICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgfVxuICAgIGlmIChjYW5jZWxsaW5nKSB7XG4gICAgICBvcHRpb25zLnNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGlmIChvcHRpb25zLnNpZ25hbC5hYm9ydGVkKSBhYm9ydCgpO1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy5pbnB1dCAhPT0gdW5kZWZpbmVkKSBjaGlsZC5zdGRpbj8uZW5kKG9wdGlvbnMuaW5wdXQpO1xuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBjbG9zZWQ7XG4gICAgaWYgKGNhbmNlbGxpbmcgJiYgb3B0aW9ucy5zaWduYWwuYWJvcnRlZCkgc3RvcChcIlNJR0tJTExcIik7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoa2lsbGluZyk7XG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIiAmJiBjaGlsZC5waWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgICAgIGZvciAoOzspIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgMCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPT09IFwiRVNSQ0hcIikgYnJlYWs7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKERhdGUubm93KCkgPj0gZGVhZGxpbmUpIHtcbiAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoXCJDaGlsZCBkZXNjZW5kYW50cyByZW1haW4gYWN0aXZlOyBwcmVzZXJ2aW5nIG93bmVkIHNjcmF0Y2hcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgZGVsYXkoMTApO1xuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29tcGxldGVkPy4oKTtcbiAgICB9IGNhdGNoIChjYXVzZSkge1xuICAgICAgY29uc3Qgb3duZXJzaGlwID0gY2F1c2UgaW5zdGFuY2VvZiBFcnJvciA/IGNhdXNlIDogbmV3IEVycm9yKFwiQ2hpbGQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZSB9KTtcbiAgICAgIGZhaWx1cmUgPSBmYWlsdXJlXG4gICAgICAgID8gbmV3IEFnZ3JlZ2F0ZUVycm9yKFtmYWlsdXJlLCBvd25lcnNoaXBdLCBcIkNoaWxkIGV4ZWN1dGlvbiBhbmQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZTogZmFpbHVyZSB9KVxuICAgICAgICA6IG93bmVyc2hpcDtcbiAgICB9XG4gICAgcmV0dXJuIHsgLi4ub3V0Y29tZSwgLi4uKGZhaWx1cmUgPyB7IGVycm9yOiBmYWlsdXJlIH0gOiB7fSkgfTtcbiAgfSBmaW5hbGx5IHtcbiAgICBvcHRpb25zLnNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnQpO1xuICAgIGZvciAoY29uc3QgdGltZXIgb2YgdGltZXJzKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICB9XG59XG5cbi8qKiBDYXB0dXJlIG9ubHkgc21hbGwgcHJvdG9jb2wvcXVlcnkgb3V0cHV0LiBFZmZlY3RmdWwgdmVyYm9zZSBjb21tYW5kcyBzaG91bGQgcmV0YWluIHN0cmVhbWVkIGxvZ3MgaW5zdGVhZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYXB0dXJlT3duZWRDaGlsZChcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogT21pdDxPd25lZENoaWxkT3B0aW9ucywgXCJvdXRwdXRcIj4sXG4gIGxpbWl0ID0gMTAyNCAqIDEwMjQsXG4pIHtcbiAgY29uc3Qgc3Rkb3V0OiBCdWZmZXJbXSA9IFtdLFxuICAgIHN0ZGVycjogQnVmZmVyW10gPSBbXTtcbiAgbGV0IGJ5dGVzID0gMDtcbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgYXJncywge1xuICAgIC4uLm9wdGlvbnMsXG4gICAgb3V0cHV0OiAob3V0LCBlcnIpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW3N0cmVhbSwgY2h1bmtzXSBvZiBbXG4gICAgICAgIFtvdXQsIHN0ZG91dF0sXG4gICAgICAgIFtlcnIsIHN0ZGVycl0sXG4gICAgICBdIGFzIGNvbnN0KVxuICAgICAgICBzdHJlYW0ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICAgICAgYnl0ZXMgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgIGlmIChieXRlcyA8PSBsaW1pdCkgY2h1bmtzLnB1c2goY2h1bmspO1xuICAgICAgICB9KTtcbiAgICB9LFxuICB9KTtcbiAgcmV0dXJuIHtcbiAgICAuLi5vdXRjb21lLFxuICAgIC4uLihieXRlcyA+IGxpbWl0ID8geyBlcnJvcjogbmV3IEVycm9yKGBDYXB0dXJlZCBjb21tYW5kIG91dHB1dCBleGNlZWRzICR7U3RyaW5nKGxpbWl0KX0gYnl0ZXNgKSB9IDoge30pLFxuICAgIHN0ZG91dDogQnVmZmVyLmNvbmNhdChzdGRvdXQpLnRvU3RyaW5nKFwidXRmOFwiKSxcbiAgICBzdGRlcnI6IEJ1ZmZlci5jb25jYXQoc3RkZXJyKS50b1N0cmluZyhcInV0ZjhcIiksXG4gIH07XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGFBQXVDO0FBRWhELFNBQVMsY0FBYyxhQUFhO0FBb0I3QixTQUFTLHNCQUFzQjtBQUNwQyxRQUFNLGFBQWEsSUFBSSxnQkFBZ0I7QUFDdkMsUUFBTSxZQUFZLE1BQU07QUFDdEIsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDQSxVQUFRLEdBQUcsVUFBVSxTQUFTO0FBQzlCLFVBQVEsR0FBRyxXQUFXLFNBQVM7QUFDL0IsU0FBTztBQUFBLElBQ0wsUUFBUSxXQUFX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QUEyRDtBQUNqRjtBQUFBLFFBQ0Y7QUFDQSxjQUFNLE1BQU0sRUFBRTtBQUFBLE1BQ2hCO0FBQUEsSUFDRjtBQUNBLFFBQUk7QUFDRixrQkFBWTtBQUFBLElBQ2QsU0FBUyxPQUFPO0FBQ2QsWUFBTSxZQUFZLGlCQUFpQixRQUFRLFFBQVEsSUFBSSxNQUFNLGlDQUFpQyxFQUFFLE1BQU0sQ0FBQztBQUN2RyxnQkFBVSxVQUNOLElBQUksZUFBZSxDQUFDLFNBQVMsU0FBUyxHQUFHLCtDQUErQyxFQUFFLE9BQU8sUUFBUSxDQUFDLElBQzFHO0FBQUEsSUFDTjtBQUNBLFdBQU8sRUFBRSxHQUFHLFNBQVMsR0FBSSxVQUFVLEVBQUUsT0FBTyxRQUFRLElBQUksQ0FBQyxFQUFHO0FBQUEsRUFDOUQsVUFBRTtBQUNBLFlBQVEsT0FBTyxvQkFBb0IsU0FBUyxLQUFLO0FBQ2pELGVBQVcsU0FBUyxPQUFRLGNBQWEsS0FBSztBQUFBLEVBQ2hEO0FBQ0Y7QUFHQSxlQUFzQixrQkFDcEIsU0FDQSxNQUNBLFNBQ0EsUUFBUSxPQUFPLE1BQ2Y7QUFDQSxRQUFNLFNBQW1CLENBQUMsR0FDeEIsU0FBbUIsQ0FBQztBQUN0QixNQUFJLFFBQVE7QUFDWixRQUFNLFVBQVUsTUFBTSxjQUFjLFNBQVMsTUFBTTtBQUFBLElBQ2pELEdBQUc7QUFBQSxJQUNILFFBQVEsQ0FBQyxLQUFLLFFBQVE7QUFDcEIsaUJBQVcsQ0FBQyxRQUFRLE1BQU0sS0FBSztBQUFBLFFBQzdCLENBQUMsS0FBSyxNQUFNO0FBQUEsUUFDWixDQUFDLEtBQUssTUFBTTtBQUFBLE1BQ2Q7QUFDRSxlQUFPLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQ25DLG1CQUFTLE1BQU07QUFDZixjQUFJLFNBQVMsTUFBTyxRQUFPLEtBQUssS0FBSztBQUFBLFFBQ3ZDLENBQUM7QUFBQSxJQUNMO0FBQUEsRUFDRixDQUFDO0FBQ0QsU0FBTztBQUFBLElBQ0wsR0FBRztBQUFBLElBQ0gsR0FBSSxRQUFRLFFBQVEsRUFBRSxPQUFPLElBQUksTUFBTSxtQ0FBbUMsT0FBTyxLQUFLLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQztBQUFBLElBQ3RHLFFBQVEsT0FBTyxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFBQSxJQUM3QyxRQUFRLE9BQU8sT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNO0FBQUEsRUFDL0M7QUFDRjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL293bmVkLWNoaWxkLm1qcyJ9
