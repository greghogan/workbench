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
    if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm93bmVkLWNoaWxkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NCeVN0ZGlvIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSwgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgZGVsYXkgfSBmcm9tIFwibm9kZTp0aW1lcnMvcHJvbWlzZXNcIjtcbmltcG9ydCB0eXBlIHsgUHJvY2Vzc0xvY2sgfSBmcm9tIFwiLi4vc3JjL3Byb2Nlc3MtbG9jay5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENoaWxkT3V0Y29tZSB7XG4gIHBpZDogbnVtYmVyO1xuICBzdGF0dXM6IG51bWJlciB8IG51bGw7XG4gIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsO1xuICBlcnJvcj86IEVycm9yO1xufVxuZXhwb3J0IGludGVyZmFjZSBPd25lZENoaWxkT3B0aW9ucyB7XG4gIGN3ZDogc3RyaW5nO1xuICBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52O1xuICBzaWduYWw6IEFib3J0U2lnbmFsO1xuICBvd25lcj86IFByb2Nlc3NMb2NrO1xuICBpbnB1dD86IHN0cmluZztcbiAgaW5oZXJpdElucHV0PzogYm9vbGVhbjtcbiAgc2h1dGRvd24/OiBcImNhbmNlbFwiIHwgXCJkcmFpblwiO1xuICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM/OiBib29sZWFuO1xuICBvdXRwdXQ/OiAoc3Rkb3V0OiBSZWFkYWJsZSwgc3RkZXJyOiBSZWFkYWJsZSkgPT4gdm9pZDtcbn1cbmV4cG9ydCBmdW5jdGlvbiBwcm9jZXNzQ2FuY2VsbGF0aW9uKCkge1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBpbnRlcnJ1cHQgPSAoKSA9PiB7XG4gICAgY29udHJvbGxlci5hYm9ydCgpO1xuICB9O1xuICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gIHJldHVybiB7XG4gICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICBjbG9zZTogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgaW50ZXJydXB0KTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKiBPd24gdGhlIGNvbXBsZXRlIGNoaWxkIGdyb3VwIHRocm91Z2ggY2FuY2VsbGF0aW9uIGFuZCByZWFwaW5nLCBiZWZvcmUgaXRzIHNjcmF0Y2ggZGF0YSBjYW4gYmUgcmVsZWFzZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuT3duZWRDaGlsZChcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogT3duZWRDaGlsZE9wdGlvbnMsXG4pOiBQcm9taXNlPENoaWxkT3V0Y29tZT4ge1xuICBvcHRpb25zLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICBpZiAob3B0aW9ucy5pbnB1dCAhPT0gdW5kZWZpbmVkICYmIG9wdGlvbnMuaW5oZXJpdElucHV0KVxuICAgIHRocm93IG5ldyBFcnJvcihcIkNoaWxkIGlucHV0IG11c3QgYmUgc3VwcGxpZWQgb3IgaW5oZXJpdGVkLCBub3QgYm90aFwiKTtcbiAgb3B0aW9ucy5vd25lcj8uYmVmb3JlU3Bhd24oKTtcbiAgY29uc3QgY2FuY2VsbGluZyA9IG9wdGlvbnMuc2h1dGRvd24gIT09IFwiZHJhaW5cIjtcbiAgbGV0IGNoaWxkOiBDaGlsZFByb2Nlc3NCeVN0ZGlvPFdyaXRhYmxlIHwgbnVsbCwgUmVhZGFibGUsIFJlYWRhYmxlPjtcbiAgdHJ5IHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IHtcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgZGV0YWNoZWQ6IHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIixcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiBvcHRpb25zLndpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyA/PyBmYWxzZSxcbiAgICB9O1xuICAgIGNoaWxkID1cbiAgICAgIG9wdGlvbnMuaW5wdXQgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0gfSlcbiAgICAgICAgOiBzcGF3bihjb21tYW5kLCBhcmdzLCB7IC4uLnNldHRpbmdzLCBzdGRpbzogW29wdGlvbnMuaW5oZXJpdElucHV0ID8gXCJpbmhlcml0XCIgOiBcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIG9wdGlvbnMub3duZXI/LnNwYXduZWQodW5kZWZpbmVkLCBmYWxzZSk7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgbGV0IGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkO1xuICBjb25zdCBraWxsaW5nOiBQcm9taXNlPHZvaWQ+W10gPSBbXTtcbiAgY29uc3Qgc3RvcCA9IChzaWduYWw6IE5vZGVKUy5TaWduYWxzKSA9PiB7XG4gICAgaWYgKGNoaWxkLnBpZCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgLy8gQSBjbG9zZWQgV2luZG93cyBwYXJlbnQgbm8gbG9uZ2VyIG93bnMgaXRzIG51bWVyaWMgUElEOyBpdHMgaW5pdGlhbCB0cmVlIGtpbGwgaXMgYXdhaXRlZCBiZWxvdy5cbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmIChjaGlsZC5leGl0Q29kZSAhPT0gbnVsbCB8fCBjaGlsZC5zaWduYWxDb2RlICE9PSBudWxsKSkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiKSBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgc2lnbmFsKTtcbiAgICAgIGVsc2VcbiAgICAgICAga2lsbGluZy5wdXNoKFxuICAgICAgICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBraWxsZXIgPSBzcGF3bihcInRhc2traWxsXCIsIFtcIi9QSURcIiwgU3RyaW5nKGNoaWxkLnBpZCksIFwiL1RcIiwgXCIvRlwiXSwge1xuICAgICAgICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGtpbGxlci5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgICAgICAgICAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAga2lsbGVyLm9uKFwiY2xvc2VcIiwgKCkgPT4ge1xuICAgICAgICAgICAgICByZXNvbHZlKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KSxcbiAgICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRVNSQ0hcIilcbiAgICAgICAgZmFpbHVyZSA/Pz0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgdGVybWluYXRpb24gZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgdGltZXJzOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PltdID0gW107XG4gIGNvbnN0IGFib3J0ID0gKCkgPT4ge1xuICAgIHN0b3AoXCJTSUdJTlRcIik7XG4gICAgdGltZXJzLnB1c2goXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgc3RvcChcIlNJR1RFUk1cIik7XG4gICAgICB9LCA1MDAwKSxcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICAgIH0sIDEwMDAwKSxcbiAgICApO1xuICB9O1xuICBjaGlsZC5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgIGZhaWx1cmUgPz89IGVycm9yO1xuICB9KTtcbiAgY2hpbGQuc3RkaW4/Lm9uKFwiZXJyb3JcIiwgKGVycm9yKSA9PiB7XG4gICAgZmFpbHVyZSA/Pz0gZXJyb3I7XG4gIH0pO1xuICBjb25zdCBjbG9zZWQgPSBuZXcgUHJvbWlzZTxDaGlsZE91dGNvbWU+KChyZXNvbHZlKSA9PiB7XG4gICAgY2hpbGQub25jZShcImNsb3NlXCIsIChzdGF0dXMsIHNpZ25hbCkgPT4ge1xuICAgICAgcmVzb2x2ZSh7IHBpZDogY2hpbGQucGlkID8/IDAsIHN0YXR1cywgc2lnbmFsIH0pO1xuICAgIH0pO1xuICB9KTtcbiAgbGV0IGNvbXBsZXRlZDogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbXBsZXRlZCA9IG9wdGlvbnMub3duZXI/LnNwYXduZWQoY2hpbGQucGlkLCBwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgIGF3YWl0IGNsb3NlZDtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICB0cnkge1xuICAgIHRyeSB7XG4gICAgICBpZiAob3B0aW9ucy5vdXRwdXQpIG9wdGlvbnMub3V0cHV0KGNoaWxkLnN0ZG91dCwgY2hpbGQuc3RkZXJyKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjaGlsZC5zdGRvdXQucGlwZShwcm9jZXNzLnN0ZG91dCwgeyBlbmQ6IGZhbHNlIH0pO1xuICAgICAgICBjaGlsZC5zdGRlcnIucGlwZShwcm9jZXNzLnN0ZGVyciwgeyBlbmQ6IGZhbHNlIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsdXJlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgb3V0cHV0IHNldHVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KTtcbiAgICAgIGNoaWxkLnN0ZG91dC5yZXN1bWUoKTtcbiAgICAgIGNoaWxkLnN0ZGVyci5yZXN1bWUoKTtcbiAgICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgIH1cbiAgICBpZiAoY2FuY2VsbGluZykge1xuICAgICAgb3B0aW9ucy5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBpZiAob3B0aW9ucy5zaWduYWwuYWJvcnRlZCkgYWJvcnQoKTtcbiAgICB9XG4gICAgaWYgKG9wdGlvbnMuaW5wdXQgIT09IHVuZGVmaW5lZCkgY2hpbGQuc3RkaW4/LmVuZChvcHRpb25zLmlucHV0KTtcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgY2xvc2VkO1xuICAgIGlmIChjYW5jZWxsaW5nICYmIG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKGtpbGxpbmcpO1xuICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIgJiYgY2hpbGQucGlkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gICAgICBmb3IgKDs7KSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcHJvY2Vzcy5raWxsKC1jaGlsZC5waWQsIDApO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID09PSBcIkVTUkNIXCIpIGJyZWFrO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIGlmIChEYXRlLm5vdygpID49IGRlYWRsaW5lKSB7XG4gICAgICAgICAgZmFpbHVyZSA/Pz0gbmV3IEVycm9yKFwiQ2hpbGQgZGVzY2VuZGFudHMgcmVtYWluIGFjdGl2ZTsgcHJlc2VydmluZyBvd25lZCBzY3JhdGNoXCIpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGRlbGF5KDEwKTtcbiAgICAgIH1cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbXBsZXRlZD8uKCk7XG4gICAgfSBjYXRjaCAoY2F1c2UpIHtcbiAgICAgIGNvbnN0IG93bmVyc2hpcCA9IGNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyBjYXVzZSA6IG5ldyBFcnJvcihcIkNoaWxkIG93bmVyc2hpcCB1cGRhdGUgZmFpbGVkXCIsIHsgY2F1c2UgfSk7XG4gICAgICBmYWlsdXJlID0gZmFpbHVyZVxuICAgICAgICA/IG5ldyBBZ2dyZWdhdGVFcnJvcihbZmFpbHVyZSwgb3duZXJzaGlwXSwgXCJDaGlsZCBleGVjdXRpb24gYW5kIG93bmVyc2hpcCB1cGRhdGUgZmFpbGVkXCIsIHsgY2F1c2U6IGZhaWx1cmUgfSlcbiAgICAgICAgOiBvd25lcnNoaXA7XG4gICAgfVxuICAgIHJldHVybiB7IC4uLm91dGNvbWUsIC4uLihmYWlsdXJlID8geyBlcnJvcjogZmFpbHVyZSB9IDoge30pIH07XG4gIH0gZmluYWxseSB7XG4gICAgb3B0aW9ucy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0KTtcbiAgICBmb3IgKGNvbnN0IHRpbWVyIG9mIHRpbWVycykgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfVxufVxuXG4vKiogQ2FwdHVyZSBvbmx5IHNtYWxsIHByb3RvY29sL3F1ZXJ5IG91dHB1dC4gRWZmZWN0ZnVsIHZlcmJvc2UgY29tbWFuZHMgc2hvdWxkIHJldGFpbiBzdHJlYW1lZCBsb2dzIGluc3RlYWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FwdHVyZU93bmVkQ2hpbGQoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IE9taXQ8T3duZWRDaGlsZE9wdGlvbnMsIFwib3V0cHV0XCI+LFxuICBsaW1pdCA9IDEwMjQgKiAxMDI0LFxuKSB7XG4gIGNvbnN0IHN0ZG91dDogQnVmZmVyW10gPSBbXSxcbiAgICBzdGRlcnI6IEJ1ZmZlcltdID0gW107XG4gIGxldCBieXRlcyA9IDA7XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBydW5Pd25lZENoaWxkKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICAuLi5vcHRpb25zLFxuICAgIG91dHB1dDogKG91dCwgZXJyKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtzdHJlYW0sIGNodW5rc10gb2YgW1xuICAgICAgICBbb3V0LCBzdGRvdXRdLFxuICAgICAgICBbZXJyLCBzdGRlcnJdLFxuICAgICAgXSBhcyBjb25zdClcbiAgICAgICAgc3RyZWFtLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgICAgIGJ5dGVzICs9IGNodW5rLmxlbmd0aDtcbiAgICAgICAgICBpZiAoYnl0ZXMgPD0gbGltaXQpIGNodW5rcy5wdXNoKGNodW5rKTtcbiAgICAgICAgfSk7XG4gICAgfSxcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgLi4ub3V0Y29tZSxcbiAgICAuLi4oYnl0ZXMgPiBsaW1pdCA/IHsgZXJyb3I6IG5ldyBFcnJvcihgQ2FwdHVyZWQgY29tbWFuZCBvdXRwdXQgZXhjZWVkcyAke1N0cmluZyhsaW1pdCl9IGJ5dGVzYCkgfSA6IHt9KSxcbiAgICBzdGRvdXQ6IEJ1ZmZlci5jb25jYXQoc3Rkb3V0KS50b1N0cmluZyhcInV0ZjhcIiksXG4gICAgc3RkZXJyOiBCdWZmZXIuY29uY2F0KHN0ZGVycikudG9TdHJpbmcoXCJ1dGY4XCIpLFxuICB9O1xufVxuIl0sIm1hcHBpbmdzIjoiO0FB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QUFBLFFBQzdCLENBQUMsS0FBSyxNQUFNO0FBQUEsUUFDWixDQUFDLEtBQUssTUFBTTtBQUFBLE1BQ2Q7QUFDRSxlQUFPLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQ25DLG1CQUFTLE1BQU07QUFDZixjQUFJLFNBQVMsTUFBTyxRQUFPLEtBQUssS0FBSztBQUFBLFFBQ3ZDLENBQUM7QUFBQSxJQUNMO0FBQUEsRUFDRixDQUFDO0FBQ0QsU0FBTztBQUFBLElBQ0wsR0FBRztBQUFBLElBQ0gsR0FBSSxRQUFRLFFBQVEsRUFBRSxPQUFPLElBQUksTUFBTSxtQ0FBbUMsT0FBTyxLQUFLLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQztBQUFBLElBQ3RHLFFBQVEsT0FBTyxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFBQSxJQUM3QyxRQUFRLE9BQU8sT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNO0FBQUEsRUFDL0M7QUFDRjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL293bmVkLWNoaWxkLm1qcyJ9
