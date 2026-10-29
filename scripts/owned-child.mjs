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
      // CREATE_NO_WINDOW would detach compiler workers from their private UTF-8 console.
      windowsHide: options.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1",
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false
    };
    child = options.input !== void 0 ? spawn(command, args, { ...settings, stdio: ["pipe", "pipe", "pipe"] }) : spawn(command, args, { ...settings, stdio: [options.inheritInput ? "inherit" : "ignore", "pipe", "pipe"] });
  } catch (error) {
    options.owner?.spawned(void 0, false);
    throw error;
  }
  let failure;
  let descendantsActive = false;
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
  if (options.stopDescendantsOnExit)
    child.once("exit", () => {
      stop("SIGTERM");
      timers.push(
        setTimeout(() => {
          stop("SIGKILL");
        }, 2e3)
      );
    });
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
          descendantsActive = true;
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
    return {
      ...outcome,
      ...failure ? { error: failure } : {},
      ...descendantsActive ? { descendantsActive: true } : {}
    };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm93bmVkLWNoaWxkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NCeVN0ZGlvIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSwgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgZGVsYXkgfSBmcm9tIFwibm9kZTp0aW1lcnMvcHJvbWlzZXNcIjtcbmltcG9ydCB0eXBlIHsgUHJvY2Vzc0xvY2sgfSBmcm9tIFwiLi4vc3JjL3Byb2Nlc3MtbG9jay5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENoaWxkT3V0Y29tZSB7XG4gIHBpZDogbnVtYmVyO1xuICBzdGF0dXM6IG51bWJlciB8IG51bGw7XG4gIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsO1xuICBlcnJvcj86IEVycm9yO1xuICBkZXNjZW5kYW50c0FjdGl2ZT86IGJvb2xlYW47XG59XG5leHBvcnQgaW50ZXJmYWNlIE93bmVkQ2hpbGRPcHRpb25zIHtcbiAgY3dkOiBzdHJpbmc7XG4gIGVudjogTm9kZUpTLlByb2Nlc3NFbnY7XG4gIHNpZ25hbDogQWJvcnRTaWduYWw7XG4gIG93bmVyPzogUHJvY2Vzc0xvY2s7XG4gIGlucHV0Pzogc3RyaW5nO1xuICBpbmhlcml0SW5wdXQ/OiBib29sZWFuO1xuICBzaHV0ZG93bj86IFwiY2FuY2VsXCIgfCBcImRyYWluXCI7XG4gIHN0b3BEZXNjZW5kYW50c09uRXhpdD86IGJvb2xlYW47XG4gIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cz86IGJvb2xlYW47XG4gIG91dHB1dD86IChzdGRvdXQ6IFJlYWRhYmxlLCBzdGRlcnI6IFJlYWRhYmxlKSA9PiB2b2lkO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHByb2Nlc3NDYW5jZWxsYXRpb24oKSB7XG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IGludGVycnVwdCA9ICgpID0+IHtcbiAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gIH07XG4gIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgaW50ZXJydXB0KTtcbiAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgaW50ZXJydXB0KTtcbiAgcmV0dXJuIHtcbiAgICBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLFxuICAgIGNsb3NlOiAoKSA9PiB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIE93biB0aGUgY29tcGxldGUgY2hpbGQgZ3JvdXAgdGhyb3VnaCBjYW5jZWxsYXRpb24gYW5kIHJlYXBpbmcsIGJlZm9yZSBpdHMgc2NyYXRjaCBkYXRhIGNhbiBiZSByZWxlYXNlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5Pd25lZENoaWxkKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPd25lZENoaWxkT3B0aW9ucyxcbik6IFByb21pc2U8Q2hpbGRPdXRjb21lPiB7XG4gIG9wdGlvbnMuc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gIGlmIChvcHRpb25zLmlucHV0ICE9PSB1bmRlZmluZWQgJiYgb3B0aW9ucy5pbmhlcml0SW5wdXQpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2hpbGQgaW5wdXQgbXVzdCBiZSBzdXBwbGllZCBvciBpbmhlcml0ZWQsIG5vdCBib3RoXCIpO1xuICBvcHRpb25zLm93bmVyPy5iZWZvcmVTcGF3bigpO1xuICBjb25zdCBjYW5jZWxsaW5nID0gb3B0aW9ucy5zaHV0ZG93biAhPT0gXCJkcmFpblwiO1xuICBsZXQgY2hpbGQ6IENoaWxkUHJvY2Vzc0J5U3RkaW88V3JpdGFibGUgfCBudWxsLCBSZWFkYWJsZSwgUmVhZGFibGU+O1xuICB0cnkge1xuICAgIGNvbnN0IHNldHRpbmdzID0ge1xuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIGVudjogb3B0aW9ucy5lbnYsXG4gICAgICBkZXRhY2hlZDogcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiLFxuICAgICAgLy8gQ1JFQVRFX05PX1dJTkRPVyB3b3VsZCBkZXRhY2ggY29tcGlsZXIgd29ya2VycyBmcm9tIHRoZWlyIHByaXZhdGUgVVRGLTggY29uc29sZS5cbiAgICAgIHdpbmRvd3NIaWRlOiBvcHRpb25zLmVudi5XT1JLQkVOQ0hfTkFUSVZFX1VURjhfQ09OU09MRSAhPT0gXCIxXCIsXG4gICAgICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IG9wdGlvbnMud2luZG93c1ZlcmJhdGltQXJndW1lbnRzID8/IGZhbHNlLFxuICAgIH07XG4gICAgY2hpbGQgPVxuICAgICAgb3B0aW9ucy5pbnB1dCAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gc3Bhd24oY29tbWFuZCwgYXJncywgeyAuLi5zZXR0aW5ncywgc3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSB9KVxuICAgICAgICA6IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbb3B0aW9ucy5pbmhlcml0SW5wdXQgPyBcImluaGVyaXRcIiA6IFwiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0gfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgb3B0aW9ucy5vd25lcj8uc3Bhd25lZCh1bmRlZmluZWQsIGZhbHNlKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gIGxldCBkZXNjZW5kYW50c0FjdGl2ZSA9IGZhbHNlO1xuICBjb25zdCBraWxsaW5nOiBQcm9taXNlPHZvaWQ+W10gPSBbXTtcbiAgY29uc3Qgc3RvcCA9IChzaWduYWw6IE5vZGVKUy5TaWduYWxzKSA9PiB7XG4gICAgaWYgKGNoaWxkLnBpZCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgLy8gQSBjbG9zZWQgV2luZG93cyBwYXJlbnQgbm8gbG9uZ2VyIG93bnMgaXRzIG51bWVyaWMgUElEOyBpdHMgaW5pdGlhbCB0cmVlIGtpbGwgaXMgYXdhaXRlZCBiZWxvdy5cbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmIChjaGlsZC5leGl0Q29kZSAhPT0gbnVsbCB8fCBjaGlsZC5zaWduYWxDb2RlICE9PSBudWxsKSkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiKSBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgc2lnbmFsKTtcbiAgICAgIGVsc2VcbiAgICAgICAga2lsbGluZy5wdXNoKFxuICAgICAgICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBraWxsZXIgPSBzcGF3bihcInRhc2traWxsXCIsIFtcIi9QSURcIiwgU3RyaW5nKGNoaWxkLnBpZCksIFwiL1RcIiwgXCIvRlwiXSwge1xuICAgICAgICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGtpbGxlci5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgICAgICAgICAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAga2lsbGVyLm9uKFwiY2xvc2VcIiwgKCkgPT4ge1xuICAgICAgICAgICAgICByZXNvbHZlKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KSxcbiAgICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRVNSQ0hcIilcbiAgICAgICAgZmFpbHVyZSA/Pz0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgdGVybWluYXRpb24gZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgdGltZXJzOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PltdID0gW107XG4gIGlmIChvcHRpb25zLnN0b3BEZXNjZW5kYW50c09uRXhpdClcbiAgICBjaGlsZC5vbmNlKFwiZXhpdFwiLCAoKSA9PiB7XG4gICAgICBzdG9wKFwiU0lHVEVSTVwiKTtcbiAgICAgIHRpbWVycy5wdXNoKFxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICAgICAgfSwgMjAwMCksXG4gICAgICApO1xuICAgIH0pO1xuICBjb25zdCBhYm9ydCA9ICgpID0+IHtcbiAgICBzdG9wKFwiU0lHSU5UXCIpO1xuICAgIHRpbWVycy5wdXNoKFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdURVJNXCIpO1xuICAgICAgfSwgNTAwMCksXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgICB9LCAxMDAwMCksXG4gICAgKTtcbiAgfTtcbiAgY2hpbGQub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IHtcbiAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgfSk7XG4gIGNoaWxkLnN0ZGluPy5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgIGZhaWx1cmUgPz89IGVycm9yO1xuICB9KTtcbiAgY29uc3QgY2xvc2VkID0gbmV3IFByb21pc2U8Q2hpbGRPdXRjb21lPigocmVzb2x2ZSkgPT4ge1xuICAgIGNoaWxkLm9uY2UoXCJjbG9zZVwiLCAoc3RhdHVzLCBzaWduYWwpID0+IHtcbiAgICAgIHJlc29sdmUoeyBwaWQ6IGNoaWxkLnBpZCA/PyAwLCBzdGF0dXMsIHNpZ25hbCB9KTtcbiAgICB9KTtcbiAgfSk7XG4gIGxldCBjb21wbGV0ZWQ6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb21wbGV0ZWQgPSBvcHRpb25zLm93bmVyPy5zcGF3bmVkKGNoaWxkLnBpZCwgcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICBhd2FpdCBjbG9zZWQ7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgdHJ5IHtcbiAgICB0cnkge1xuICAgICAgaWYgKG9wdGlvbnMub3V0cHV0KSBvcHRpb25zLm91dHB1dChjaGlsZC5zdGRvdXQsIGNoaWxkLnN0ZGVycik7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY2hpbGQuc3Rkb3V0LnBpcGUocHJvY2Vzcy5zdGRvdXQsIHsgZW5kOiBmYWxzZSB9KTtcbiAgICAgICAgY2hpbGQuc3RkZXJyLnBpcGUocHJvY2Vzcy5zdGRlcnIsIHsgZW5kOiBmYWxzZSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgZmFpbHVyZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIkNoaWxkIG91dHB1dCBzZXR1cCBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSk7XG4gICAgICBjaGlsZC5zdGRvdXQucmVzdW1lKCk7XG4gICAgICBjaGlsZC5zdGRlcnIucmVzdW1lKCk7XG4gICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICB9XG4gICAgaWYgKGNhbmNlbGxpbmcpIHtcbiAgICAgIG9wdGlvbnMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgaWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIGFib3J0KCk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLmlucHV0ICE9PSB1bmRlZmluZWQpIGNoaWxkLnN0ZGluPy5lbmQob3B0aW9ucy5pbnB1dCk7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IGNsb3NlZDtcbiAgICBpZiAoY2FuY2VsbGluZyAmJiBvcHRpb25zLnNpZ25hbC5hYm9ydGVkKSBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChraWxsaW5nKTtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiICYmIGNoaWxkLnBpZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICAgICAgZm9yICg7Oykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHByb2Nlc3Mua2lsbCgtY2hpbGQucGlkLCAwKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSA9PT0gXCJFU1JDSFwiKSBicmVhaztcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoRGF0ZS5ub3coKSA+PSBkZWFkbGluZSkge1xuICAgICAgICAgIGRlc2NlbmRhbnRzQWN0aXZlID0gdHJ1ZTtcbiAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoXCJDaGlsZCBkZXNjZW5kYW50cyByZW1haW4gYWN0aXZlOyBwcmVzZXJ2aW5nIG93bmVkIHNjcmF0Y2hcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgZGVsYXkoMTApO1xuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29tcGxldGVkPy4oKTtcbiAgICB9IGNhdGNoIChjYXVzZSkge1xuICAgICAgY29uc3Qgb3duZXJzaGlwID0gY2F1c2UgaW5zdGFuY2VvZiBFcnJvciA/IGNhdXNlIDogbmV3IEVycm9yKFwiQ2hpbGQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZSB9KTtcbiAgICAgIGZhaWx1cmUgPSBmYWlsdXJlXG4gICAgICAgID8gbmV3IEFnZ3JlZ2F0ZUVycm9yKFtmYWlsdXJlLCBvd25lcnNoaXBdLCBcIkNoaWxkIGV4ZWN1dGlvbiBhbmQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZTogZmFpbHVyZSB9KVxuICAgICAgICA6IG93bmVyc2hpcDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLm91dGNvbWUsXG4gICAgICAuLi4oZmFpbHVyZSA/IHsgZXJyb3I6IGZhaWx1cmUgfSA6IHt9KSxcbiAgICAgIC4uLihkZXNjZW5kYW50c0FjdGl2ZSA/IHsgZGVzY2VuZGFudHNBY3RpdmU6IHRydWUgfSA6IHt9KSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIG9wdGlvbnMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCk7XG4gICAgZm9yIChjb25zdCB0aW1lciBvZiB0aW1lcnMpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gIH1cbn1cblxuLyoqIENhcHR1cmUgb25seSBzbWFsbCBwcm90b2NvbC9xdWVyeSBvdXRwdXQuIEVmZmVjdGZ1bCB2ZXJib3NlIGNvbW1hbmRzIHNob3VsZCByZXRhaW4gc3RyZWFtZWQgbG9ncyBpbnN0ZWFkLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVPd25lZENoaWxkKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPbWl0PE93bmVkQ2hpbGRPcHRpb25zLCBcIm91dHB1dFwiPixcbiAgbGltaXQgPSAxMDI0ICogMTAyNCxcbikge1xuICBjb25zdCBzdGRvdXQ6IEJ1ZmZlcltdID0gW10sXG4gICAgc3RkZXJyOiBCdWZmZXJbXSA9IFtdO1xuICBsZXQgYnl0ZXMgPSAwO1xuICBjb25zdCBvdXRjb21lID0gYXdhaXQgcnVuT3duZWRDaGlsZChjb21tYW5kLCBhcmdzLCB7XG4gICAgLi4ub3B0aW9ucyxcbiAgICBvdXRwdXQ6IChvdXQsIGVycikgPT4ge1xuICAgICAgZm9yIChjb25zdCBbc3RyZWFtLCBjaHVua3NdIG9mIFtcbiAgICAgICAgW291dCwgc3Rkb3V0XSxcbiAgICAgICAgW2Vyciwgc3RkZXJyXSxcbiAgICAgIF0gYXMgY29uc3QpXG4gICAgICAgIHN0cmVhbS5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IHtcbiAgICAgICAgICBieXRlcyArPSBjaHVuay5sZW5ndGg7XG4gICAgICAgICAgaWYgKGJ5dGVzIDw9IGxpbWl0KSBjaHVua3MucHVzaChjaHVuayk7XG4gICAgICAgIH0pO1xuICAgIH0sXG4gIH0pO1xuICByZXR1cm4ge1xuICAgIC4uLm91dGNvbWUsXG4gICAgLi4uKGJ5dGVzID4gbGltaXQgPyB7IGVycm9yOiBuZXcgRXJyb3IoYENhcHR1cmVkIGNvbW1hbmQgb3V0cHV0IGV4Y2VlZHMgJHtTdHJpbmcobGltaXQpfSBieXRlc2ApIH0gOiB7fSksXG4gICAgc3Rkb3V0OiBCdWZmZXIuY29uY2F0KHN0ZG91dCkudG9TdHJpbmcoXCJ1dGY4XCIpLFxuICAgIHN0ZGVycjogQnVmZmVyLmNvbmNhdChzdGRlcnIpLnRvU3RyaW5nKFwidXRmOFwiKSxcbiAgfTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsYUFBdUM7QUFFaEQsU0FBUyxjQUFjLGFBQWE7QUFzQjdCLFNBQVMsc0JBQXNCO0FBQ3BDLFFBQU0sYUFBYSxJQUFJLGdCQUFnQjtBQUN2QyxRQUFNLFlBQVksTUFBTTtBQUN0QixlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNBLFVBQVEsR0FBRyxVQUFVLFNBQVM7QUFDOUIsVUFBUSxHQUFHLFdBQVcsU0FBUztBQUMvQixTQUFPO0FBQUEsSUFDTCxRQUFRLFdBQVc7QUFBQSxJQUNuQixPQUFPLE1BQU07QUFDWCxjQUFRLElBQUksVUFBVSxTQUFTO0FBQy9CLGNBQVEsSUFBSSxXQUFXLFNBQVM7QUFBQSxJQUNsQztBQUFBLEVBQ0Y7QUFDRjtBQUdBLGVBQXNCLGNB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QUFLLENBQUM7QUFBQSxRQUM1QixTQUFTLE9BQU87QUFDZCxjQUFLLE1BQWdDLFNBQVMsUUFBUztBQUN2RCxnQkFBTTtBQUFBLFFBQ1I7QUFDQSxZQUFJLEtBQUssSUFBSSxLQUFLLFVBQVU7QUFDMUIsOEJBQW9CO0FBQ3BCLHNCQUFZLElBQUksTUFBTSwyREFBMkQ7QUFDakY7QUFBQSxRQUNGO0FBQ0EsY0FBTSxNQUFNLEVBQUU7QUFBQSxNQUNoQjtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0Ysa0JBQVk7QUFBQSxJQUNkLFNBQVMsT0FBTztBQUNkLFlBQU0sWUFBWSxpQkFBaUIsUUFBUSxRQUFRLElBQUksTUFBTSxpQ0FBaUMsRUFBRSxNQUFNLENBQUM7QUFDdkcsZ0JBQVUsVUFDTixJQUFJLGVBQWUsQ0FBQyxTQUFTLFNBQVMsR0FBRywrQ0FBK0MsRUFBRSxPQUFPLFFBQVEsQ0FBQyxJQUMxRztBQUFBLElBQ047QUFDQSxXQUFPO0FBQUEsTUFDTCxHQUFHO0FBQUEsTUFDSCxHQUFJLFVBQVUsRUFBRSxPQUFPLFFBQVEsSUFBSSxDQUFDO0FBQUEsTUFDcEMsR0FBSSxvQkFBb0IsRUFBRSxtQkFBbUIsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUN6RDtBQUFBLEVBQ0YsVUFBRTtBQUNBLFlBQVEsT0FBTyxvQkFBb0IsU0FBUyxLQUFLO0FBQ2pELGVBQVcsU0FBUyxPQUFRLGNBQWEsS0FBSztBQUFBLEVBQ2hEO0FBQ0Y7QUFHQSxlQUFzQixrQkFDcEIsU0FDQSxNQUNBLFNBQ0EsUUFBUSxPQUFPLE1BQ2Y7QUFDQSxRQUFNLFNBQW1CLENBQUMsR0FDeEIsU0FBbUIsQ0FBQztBQUN0QixNQUFJLFFBQVE7QUFDWixRQUFNLFVBQVUsTUFBTSxjQUFjLFNBQVMsTUFBTTtBQUFBLElBQ2pELEdBQUc7QUFBQSxJQUNILFFBQVEsQ0FBQyxLQUFLLFFBQVE7QUFDcEIsaUJBQVcsQ0FBQyxRQUFRLE1BQU0sS0FBSztBQUFBLFFBQzdCLENBQUMsS0FBSyxNQUFNO0FBQUEsUUFDWixDQUFDLEtBQUssTUFBTTtBQUFBLE1BQ2Q7QUFDRSxlQUFPLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQ25DLG1CQUFTLE1BQU07QUFDZixjQUFJLFNBQVMsTUFBTyxRQUFPLEtBQUssS0FBSztBQUFBLFFBQ3ZDLENBQUM7QUFBQSxJQUNMO0FBQUEsRUFDRixDQUFDO0FBQ0QsU0FBTztBQUFBLElBQ0wsR0FBRztBQUFBLElBQ0gsR0FBSSxRQUFRLFFBQVEsRUFBRSxPQUFPLElBQUksTUFBTSxtQ0FBbUMsT0FBTyxLQUFLLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQztBQUFBLElBQ3RHLFFBQVEsT0FBTyxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFBQSxJQUM3QyxRQUFRLE9BQU8sT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNO0FBQUEsRUFDL0M7QUFDRjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL293bmVkLWNoaWxkLm1qcyJ9
