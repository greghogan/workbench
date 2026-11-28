// Generated from owned-child.mts; edit the TypeScript source.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import { spawnWindowsProcess } from "./windows-process.mjs";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
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
function connectInput(child, input, fail, stop) {
  if (typeof input === "string") {
    child.stdin?.end(input);
    return;
  }
  if (!input) return;
  const failed = (error) => {
    fail(error);
    if (child.exitCode === null && child.signalCode === null) stop();
  };
  input.once("error", failed);
  child.stdin?.once("error", failed);
  const closed = finished(input, { cleanup: true, readable: true, writable: false }).catch((error) => {
    if (error.code !== "ERR_STREAM_PREMATURE_CLOSE")
      fail(error instanceof Error ? error : new Error("Child input cleanup failed", { cause: error }));
  });
  if (child.stdin) input.pipe(child.stdin);
  return async () => {
    if (child.stdin) input.unpipe(child.stdin);
    input.destroy();
    await closed;
    input.removeListener("error", failed);
    child.stdin?.removeListener("error", failed);
  };
}
function connectOutput(child, options) {
  if (options.inheritOutput) return;
  if (!child.stdout || !child.stderr) throw new Error("Owned command output requires readable pipes");
  if (options.output) options.output(child.stdout, child.stderr);
  else {
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
  }
}
async function runWindowsOwnedChild(command, args, options) {
  options.owner?.beforeSpawn();
  let running;
  try {
    running = await spawnWindowsProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.input !== void 0 ? "pipe" : options.inheritInput ? "inherit" : "ignore",
      output: options.inheritOutput ? "inherit" : "pipe",
      ...options.windowsVerbatimArguments === void 0 ? {} : { windowsVerbatimArguments: options.windowsVerbatimArguments },
      ...options.stopDescendantsOnExit === void 0 ? {} : { stopDescendantsOnExit: options.stopDescendantsOnExit },
      ...options.windowsAdmission === void 0 ? {} : { machineJobId: options.windowsAdmission.jobId }
    });
  } catch (failure2) {
    try {
      options.owner?.spawned(void 0, false);
    } catch (cleanup) {
      throw combineFailures(failure2, cleanup, "Windows process preparation and ownership cleanup failed");
    }
    throw failure2;
  }
  const child = running.child;
  let failure;
  const reported = /* @__PURE__ */ new Set();
  const fail = (error) => {
    if (reported.has(error)) return;
    reported.add(error);
    failure = failure ? combineFailures(failure, error, "Windows command and cleanup failed") : error;
  };
  child.on("error", fail);
  child.stdin?.on("error", fail);
  let completed;
  let releaseInput;
  const cancelling = options.shutdown !== "drain";
  const cancel = () => {
    running.cancel();
  };
  try {
    try {
      completed = options.owner?.spawned(child.pid, false, true);
      connectOutput(child, options);
      releaseInput = connectInput(child, options.input, fail, cancel);
      if (cancelling) {
        options.signal.addEventListener("abort", cancel, { once: true });
        if (options.signal.aborted) cancel();
      }
      if (options.windowsAdmission) {
        await running.ready;
        if (!child.pid) throw new Error("The Windows job supervisor has no process ID");
        const stopped = new AbortController();
        void running.completion.then(() => {
          stopped.abort(new Error("The Windows job supervisor ended while awaiting machine admission"));
        });
        await options.windowsAdmission.wait(child.pid, AbortSignal.any([options.signal, stopped.signal]));
      }
      await running.admit();
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Windows command setup failed", { cause: error }));
      child.stdout?.resume();
      child.stderr?.resume();
      cancel();
    }
    const outcome = await running.completion;
    if (outcome.error) fail(outcome.error);
    try {
      await releaseInput?.();
      releaseInput = void 0;
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Windows command input cleanup failed", { cause: error }));
    }
    if (!outcome.jobEmpty) {
      try {
        options.owner?.markUncertain();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Cannot retain uncertain process ownership", { cause: error }));
      }
      fail(new Error(`Windows process termination is uncertain; preserving ${running.directory}`));
    } else {
      try {
        await running.dispose();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Windows process scratch cleanup failed", { cause: error }));
      }
      try {
        completed?.();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Windows process ownership cleanup failed", { cause: error }));
      }
    }
    return {
      pid: outcome.pid,
      status: outcome.status,
      signal: null,
      ...failure ? { error: failure } : {},
      ...!outcome.jobEmpty ? { descendantsActive: true } : {}
    };
  } finally {
    await releaseInput?.();
    options.signal.removeEventListener("abort", cancel);
  }
}
async function runOwnedChild(command, args, options) {
  options.signal.throwIfAborted();
  if (options.input !== void 0 && options.inheritInput)
    throw new Error("Child input must be supplied or inherited, not both");
  if (options.inheritOutput && options.output) throw new Error("Child output must be captured or inherited, not both");
  if (process.platform === "win32") return runWindowsOwnedChild(command, args, options);
  options.owner?.beforeSpawn();
  const cancelling = options.shutdown !== "drain";
  let child;
  try {
    const settings = {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      // CREATE_NO_WINDOW would detach compiler workers from their private UTF-8 console.
      windowsHide: options.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1",
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false
    };
    const output = options.inheritOutput ? "inherit" : "pipe";
    child = options.input !== void 0 ? spawn(command, args, { ...settings, stdio: ["pipe", output, output] }) : spawn(command, args, { ...settings, stdio: [options.inheritInput ? "inherit" : "ignore", output, output] });
  } catch (error) {
    options.owner?.spawned(void 0, false);
    throw error;
  }
  let failure;
  let descendantsActive = false;
  const stop = (signal) => {
    if (child.pid === void 0) return;
    try {
      process.kill(-child.pid, signal);
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
  let releaseInput;
  try {
    completed = options.owner?.spawned(child.pid, true);
  } catch (error) {
    stop("SIGKILL");
    await closed;
    throw error;
  }
  try {
    try {
      connectOutput(child, options);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Child output setup failed", { cause: error });
      child.stdout?.resume();
      child.stderr?.resume();
      stop("SIGKILL");
    }
    if (cancelling) {
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
    releaseInput = connectInput(
      child,
      options.input,
      (error) => {
        failure ??= error;
      },
      () => {
        stop("SIGKILL");
      }
    );
    const outcome = await closed;
    await releaseInput?.();
    releaseInput = void 0;
    if (cancelling && options.signal.aborted) stop("SIGKILL");
    if (child.pid !== void 0) {
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
      if (!descendantsActive) completed?.();
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
    await releaseInput?.();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm93bmVkLWNoaWxkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NCeVN0ZGlvIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSwgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgZGVsYXkgfSBmcm9tIFwibm9kZTp0aW1lcnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGZpbmlzaGVkIH0gZnJvbSBcIm5vZGU6c3RyZWFtL3Byb21pc2VzXCI7XG5pbXBvcnQgdHlwZSB7IFByb2Nlc3NMb2NrIH0gZnJvbSBcIi4uL3N0b3JhZ2UvcHJvY2Vzcy1sb2NrLmpzXCI7XG5pbXBvcnQgeyBzcGF3bldpbmRvd3NQcm9jZXNzLCB0eXBlIFdpbmRvd3NQcm9jZXNzIH0gZnJvbSBcIi4vd2luZG93cy1wcm9jZXNzLm1qc1wiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4uL2RpYWdub3N0aWNzL2RpYWdub3N0aWMtZXJyb3JzLm1qc1wiO1xuXG50eXBlIE93bmVkQ2hpbGQgPSBDaGlsZFByb2Nlc3NCeVN0ZGlvPFdyaXRhYmxlIHwgbnVsbCwgUmVhZGFibGUgfCBudWxsLCBSZWFkYWJsZSB8IG51bGw+O1xuXG5leHBvcnQgaW50ZXJmYWNlIENoaWxkT3V0Y29tZSB7XG4gIHBpZDogbnVtYmVyO1xuICBzdGF0dXM6IG51bWJlciB8IG51bGw7XG4gIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsO1xuICBlcnJvcj86IEVycm9yO1xuICBkZXNjZW5kYW50c0FjdGl2ZT86IGJvb2xlYW47XG59XG5leHBvcnQgaW50ZXJmYWNlIE93bmVkQ2hpbGRPcHRpb25zIHtcbiAgY3dkOiBzdHJpbmc7XG4gIGVudjogTm9kZUpTLlByb2Nlc3NFbnY7XG4gIHNpZ25hbDogQWJvcnRTaWduYWw7XG4gIG93bmVyPzogUHJvY2Vzc0xvY2s7XG4gIGlucHV0Pzogc3RyaW5nIHwgUmVhZGFibGU7XG4gIGluaGVyaXRJbnB1dD86IGJvb2xlYW47XG4gIGluaGVyaXRPdXRwdXQ/OiBib29sZWFuO1xuICBzaHV0ZG93bj86IFwiY2FuY2VsXCIgfCBcImRyYWluXCI7XG4gIHN0b3BEZXNjZW5kYW50c09uRXhpdD86IGJvb2xlYW47XG4gIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cz86IGJvb2xlYW47XG4gIHdpbmRvd3NBZG1pc3Npb24/OiB7XG4gICAgam9iSWQ6IHN0cmluZztcbiAgICB3YWl0KHBpZDogbnVtYmVyLCBzaWduYWw6IEFib3J0U2lnbmFsKTogUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgb3V0cHV0PzogKHN0ZG91dDogUmVhZGFibGUsIHN0ZGVycjogUmVhZGFibGUpID0+IHZvaWQ7XG59XG5leHBvcnQgZnVuY3Rpb24gcHJvY2Vzc0NhbmNlbGxhdGlvbigpIHtcbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgaW50ZXJydXB0ID0gKCkgPT4ge1xuICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgfTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICByZXR1cm4ge1xuICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsXG4gICAgY2xvc2U6ICgpID0+IHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgaW50ZXJydXB0KTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjb25uZWN0SW5wdXQoXG4gIGNoaWxkOiBPd25lZENoaWxkLFxuICBpbnB1dDogT3duZWRDaGlsZE9wdGlvbnNbXCJpbnB1dFwiXSxcbiAgZmFpbDogKGVycm9yOiBFcnJvcikgPT4gdm9pZCxcbiAgc3RvcDogKCkgPT4gdm9pZCxcbik6ICgoKSA9PiBQcm9taXNlPHZvaWQ+KSB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgaW5wdXQgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjaGlsZC5zdGRpbj8uZW5kKGlucHV0KTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFpbnB1dCkgcmV0dXJuO1xuICBjb25zdCBmYWlsZWQgPSAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgZmFpbChlcnJvcik7XG4gICAgaWYgKGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHN0b3AoKTtcbiAgfTtcbiAgaW5wdXQub25jZShcImVycm9yXCIsIGZhaWxlZCk7XG4gIGNoaWxkLnN0ZGluPy5vbmNlKFwiZXJyb3JcIiwgZmFpbGVkKTtcbiAgY29uc3QgY2xvc2VkID0gZmluaXNoZWQoaW5wdXQsIHsgY2xlYW51cDogdHJ1ZSwgcmVhZGFibGU6IHRydWUsIHdyaXRhYmxlOiBmYWxzZSB9KS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSAhPT0gXCJFUlJfU1RSRUFNX1BSRU1BVFVSRV9DTE9TRVwiKVxuICAgICAgZmFpbChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDaGlsZCBpbnB1dCBjbGVhbnVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gIH0pO1xuICBpZiAoY2hpbGQuc3RkaW4pIGlucHV0LnBpcGUoY2hpbGQuc3RkaW4pO1xuICByZXR1cm4gYXN5bmMgKCkgPT4ge1xuICAgIGlmIChjaGlsZC5zdGRpbikgaW5wdXQudW5waXBlKGNoaWxkLnN0ZGluKTtcbiAgICBpbnB1dC5kZXN0cm95KCk7XG4gICAgYXdhaXQgY2xvc2VkO1xuICAgIGlucHV0LnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgZmFpbGVkKTtcbiAgICBjaGlsZC5zdGRpbj8ucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBmYWlsZWQpO1xuICB9O1xufVxuZnVuY3Rpb24gY29ubmVjdE91dHB1dChjaGlsZDogT3duZWRDaGlsZCwgb3B0aW9uczogT3duZWRDaGlsZE9wdGlvbnMpOiB2b2lkIHtcbiAgaWYgKG9wdGlvbnMuaW5oZXJpdE91dHB1dCkgcmV0dXJuO1xuICBpZiAoIWNoaWxkLnN0ZG91dCB8fCAhY2hpbGQuc3RkZXJyKSB0aHJvdyBuZXcgRXJyb3IoXCJPd25lZCBjb21tYW5kIG91dHB1dCByZXF1aXJlcyByZWFkYWJsZSBwaXBlc1wiKTtcbiAgaWYgKG9wdGlvbnMub3V0cHV0KSBvcHRpb25zLm91dHB1dChjaGlsZC5zdGRvdXQsIGNoaWxkLnN0ZGVycik7XG4gIGVsc2Uge1xuICAgIGNoaWxkLnN0ZG91dC5waXBlKHByb2Nlc3Muc3Rkb3V0LCB7IGVuZDogZmFsc2UgfSk7XG4gICAgY2hpbGQuc3RkZXJyLnBpcGUocHJvY2Vzcy5zdGRlcnIsIHsgZW5kOiBmYWxzZSB9KTtcbiAgfVxufVxuXG4vKiogVGhlIHN1cGVydmlzb3IgcmV0YWlucyBhIGpvYiBoYW5kbGUgdW50aWwgYWxsIGRlc2NlbmRhbnRzIGFyZSBnb25lOyBQSUQgZXhpdCBpcyBub3QgZHJhaW5hZ2UgcHJvb2YuICovXG5hc3luYyBmdW5jdGlvbiBydW5XaW5kb3dzT3duZWRDaGlsZChcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogT3duZWRDaGlsZE9wdGlvbnMsXG4pOiBQcm9taXNlPENoaWxkT3V0Y29tZT4ge1xuICBvcHRpb25zLm93bmVyPy5iZWZvcmVTcGF3bigpO1xuICBsZXQgcnVubmluZzogV2luZG93c1Byb2Nlc3M7XG4gIHRyeSB7XG4gICAgcnVubmluZyA9IGF3YWl0IHNwYXduV2luZG93c1Byb2Nlc3MoY29tbWFuZCwgYXJncywge1xuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIGVudjogb3B0aW9ucy5lbnYsXG4gICAgICBzdGRpbjogb3B0aW9ucy5pbnB1dCAhPT0gdW5kZWZpbmVkID8gXCJwaXBlXCIgOiBvcHRpb25zLmluaGVyaXRJbnB1dCA/IFwiaW5oZXJpdFwiIDogXCJpZ25vcmVcIixcbiAgICAgIG91dHB1dDogb3B0aW9ucy5pbmhlcml0T3V0cHV0ID8gXCJpbmhlcml0XCIgOiBcInBpcGVcIixcbiAgICAgIC4uLihvcHRpb25zLndpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8ge31cbiAgICAgICAgOiB7IHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogb3B0aW9ucy53aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgfSksXG4gICAgICAuLi4ob3B0aW9ucy5zdG9wRGVzY2VuZGFudHNPbkV4aXQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBzdG9wRGVzY2VuZGFudHNPbkV4aXQ6IG9wdGlvbnMuc3RvcERlc2NlbmRhbnRzT25FeGl0IH0pLFxuICAgICAgLi4uKG9wdGlvbnMud2luZG93c0FkbWlzc2lvbiA9PT0gdW5kZWZpbmVkID8ge30gOiB7IG1hY2hpbmVKb2JJZDogb3B0aW9ucy53aW5kb3dzQWRtaXNzaW9uLmpvYklkIH0pLFxuICAgIH0pO1xuICB9IGNhdGNoIChmYWlsdXJlKSB7XG4gICAgdHJ5IHtcbiAgICAgIG9wdGlvbnMub3duZXI/LnNwYXduZWQodW5kZWZpbmVkLCBmYWxzZSk7XG4gICAgfSBjYXRjaCAoY2xlYW51cCkge1xuICAgICAgdGhyb3cgY29tYmluZUZhaWx1cmVzKGZhaWx1cmUsIGNsZWFudXAsIFwiV2luZG93cyBwcm9jZXNzIHByZXBhcmF0aW9uIGFuZCBvd25lcnNoaXAgY2xlYW51cCBmYWlsZWRcIik7XG4gICAgfVxuICAgIHRocm93IGZhaWx1cmU7XG4gIH1cbiAgY29uc3QgY2hpbGQgPSBydW5uaW5nLmNoaWxkO1xuICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHJlcG9ydGVkID0gbmV3IFNldDxFcnJvcj4oKTtcbiAgY29uc3QgZmFpbCA9IChlcnJvcjogRXJyb3IpID0+IHtcbiAgICBpZiAocmVwb3J0ZWQuaGFzKGVycm9yKSkgcmV0dXJuO1xuICAgIHJlcG9ydGVkLmFkZChlcnJvcik7XG4gICAgZmFpbHVyZSA9IGZhaWx1cmUgPyBjb21iaW5lRmFpbHVyZXMoZmFpbHVyZSwgZXJyb3IsIFwiV2luZG93cyBjb21tYW5kIGFuZCBjbGVhbnVwIGZhaWxlZFwiKSA6IGVycm9yO1xuICB9O1xuICBjaGlsZC5vbihcImVycm9yXCIsIGZhaWwpO1xuICBjaGlsZC5zdGRpbj8ub24oXCJlcnJvclwiLCBmYWlsKTtcbiAgbGV0IGNvbXBsZXRlZDogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkO1xuICBsZXQgcmVsZWFzZUlucHV0OiAoKCkgPT4gUHJvbWlzZTx2b2lkPikgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNhbmNlbGxpbmcgPSBvcHRpb25zLnNodXRkb3duICE9PSBcImRyYWluXCI7XG4gIGNvbnN0IGNhbmNlbCA9ICgpID0+IHtcbiAgICBydW5uaW5nLmNhbmNlbCgpO1xuICB9O1xuICB0cnkge1xuICAgIHRyeSB7XG4gICAgICBjb21wbGV0ZWQgPSBvcHRpb25zLm93bmVyPy5zcGF3bmVkKGNoaWxkLnBpZCwgZmFsc2UsIHRydWUpO1xuICAgICAgY29ubmVjdE91dHB1dChjaGlsZCwgb3B0aW9ucyk7XG4gICAgICByZWxlYXNlSW5wdXQgPSBjb25uZWN0SW5wdXQoY2hpbGQsIG9wdGlvbnMuaW5wdXQsIGZhaWwsIGNhbmNlbCk7XG4gICAgICBpZiAoY2FuY2VsbGluZykge1xuICAgICAgICBvcHRpb25zLnNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgY2FuY2VsLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIGlmIChvcHRpb25zLnNpZ25hbC5hYm9ydGVkKSBjYW5jZWwoKTtcbiAgICAgIH1cbiAgICAgIGlmIChvcHRpb25zLndpbmRvd3NBZG1pc3Npb24pIHtcbiAgICAgICAgYXdhaXQgcnVubmluZy5yZWFkeTtcbiAgICAgICAgaWYgKCFjaGlsZC5waWQpIHRocm93IG5ldyBFcnJvcihcIlRoZSBXaW5kb3dzIGpvYiBzdXBlcnZpc29yIGhhcyBubyBwcm9jZXNzIElEXCIpO1xuICAgICAgICBjb25zdCBzdG9wcGVkID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICB2b2lkIHJ1bm5pbmcuY29tcGxldGlvbi50aGVuKCgpID0+IHtcbiAgICAgICAgICBzdG9wcGVkLmFib3J0KG5ldyBFcnJvcihcIlRoZSBXaW5kb3dzIGpvYiBzdXBlcnZpc29yIGVuZGVkIHdoaWxlIGF3YWl0aW5nIG1hY2hpbmUgYWRtaXNzaW9uXCIpKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IG9wdGlvbnMud2luZG93c0FkbWlzc2lvbi53YWl0KGNoaWxkLnBpZCwgQWJvcnRTaWduYWwuYW55KFtvcHRpb25zLnNpZ25hbCwgc3RvcHBlZC5zaWduYWxdKSk7XG4gICAgICB9XG4gICAgICBhd2FpdCBydW5uaW5nLmFkbWl0KCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWwoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiV2luZG93cyBjb21tYW5kIHNldHVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgICBjaGlsZC5zdGRvdXQ/LnJlc3VtZSgpO1xuICAgICAgY2hpbGQuc3RkZXJyPy5yZXN1bWUoKTtcbiAgICAgIGNhbmNlbCgpO1xuICAgIH1cbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgcnVubmluZy5jb21wbGV0aW9uO1xuICAgIGlmIChvdXRjb21lLmVycm9yKSBmYWlsKG91dGNvbWUuZXJyb3IpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCByZWxlYXNlSW5wdXQ/LigpO1xuICAgICAgcmVsZWFzZUlucHV0ID0gdW5kZWZpbmVkO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgY29tbWFuZCBpbnB1dCBjbGVhbnVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgfVxuICAgIGlmICghb3V0Y29tZS5qb2JFbXB0eSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgb3B0aW9ucy5vd25lcj8ubWFya1VuY2VydGFpbigpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZmFpbChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDYW5ub3QgcmV0YWluIHVuY2VydGFpbiBwcm9jZXNzIG93bmVyc2hpcFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgICB9XG4gICAgICBmYWlsKG5ldyBFcnJvcihgV2luZG93cyBwcm9jZXNzIHRlcm1pbmF0aW9uIGlzIHVuY2VydGFpbjsgcHJlc2VydmluZyAke3J1bm5pbmcuZGlyZWN0b3J5fWApKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcnVubmluZy5kaXNwb3NlKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgcHJvY2VzcyBzY3JhdGNoIGNsZWFudXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pKTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbXBsZXRlZD8uKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgcHJvY2VzcyBvd25lcnNoaXAgY2xlYW51cCBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcGlkOiBvdXRjb21lLnBpZCxcbiAgICAgIHN0YXR1czogb3V0Y29tZS5zdGF0dXMsXG4gICAgICBzaWduYWw6IG51bGwsXG4gICAgICAuLi4oZmFpbHVyZSA/IHsgZXJyb3I6IGZhaWx1cmUgfSA6IHt9KSxcbiAgICAgIC4uLighb3V0Y29tZS5qb2JFbXB0eSA/IHsgZGVzY2VuZGFudHNBY3RpdmU6IHRydWUgfSA6IHt9KSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IHJlbGVhc2VJbnB1dD8uKCk7XG4gICAgb3B0aW9ucy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNhbmNlbCk7XG4gIH1cbn1cblxuLyoqIE93biB0aGUgY29tcGxldGUgY2hpbGQgZ3JvdXAgdGhyb3VnaCBjYW5jZWxsYXRpb24gYW5kIHJlYXBpbmcsIGJlZm9yZSBpdHMgc2NyYXRjaCBkYXRhIGNhbiBiZSByZWxlYXNlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5Pd25lZENoaWxkKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPd25lZENoaWxkT3B0aW9ucyxcbik6IFByb21pc2U8Q2hpbGRPdXRjb21lPiB7XG4gIG9wdGlvbnMuc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gIGlmIChvcHRpb25zLmlucHV0ICE9PSB1bmRlZmluZWQgJiYgb3B0aW9ucy5pbmhlcml0SW5wdXQpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2hpbGQgaW5wdXQgbXVzdCBiZSBzdXBwbGllZCBvciBpbmhlcml0ZWQsIG5vdCBib3RoXCIpO1xuICBpZiAob3B0aW9ucy5pbmhlcml0T3V0cHV0ICYmIG9wdGlvbnMub3V0cHV0KSB0aHJvdyBuZXcgRXJyb3IoXCJDaGlsZCBvdXRwdXQgbXVzdCBiZSBjYXB0dXJlZCBvciBpbmhlcml0ZWQsIG5vdCBib3RoXCIpO1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSByZXR1cm4gcnVuV2luZG93c093bmVkQ2hpbGQoY29tbWFuZCwgYXJncywgb3B0aW9ucyk7XG4gIG9wdGlvbnMub3duZXI/LmJlZm9yZVNwYXduKCk7XG4gIGNvbnN0IGNhbmNlbGxpbmcgPSBvcHRpb25zLnNodXRkb3duICE9PSBcImRyYWluXCI7XG4gIGxldCBjaGlsZDogT3duZWRDaGlsZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IHtcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICAvLyBDUkVBVEVfTk9fV0lORE9XIHdvdWxkIGRldGFjaCBjb21waWxlciB3b3JrZXJzIGZyb20gdGhlaXIgcHJpdmF0ZSBVVEYtOCBjb25zb2xlLlxuICAgICAgd2luZG93c0hpZGU6IG9wdGlvbnMuZW52LldPUktCRU5DSF9OQVRJVkVfVVRGOF9DT05TT0xFICE9PSBcIjFcIixcbiAgICAgIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogb3B0aW9ucy53aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgPz8gZmFsc2UsXG4gICAgfTtcbiAgICBjb25zdCBvdXRwdXQgPSBvcHRpb25zLmluaGVyaXRPdXRwdXQgPyBcImluaGVyaXRcIiA6IFwicGlwZVwiO1xuICAgIGNoaWxkID1cbiAgICAgIG9wdGlvbnMuaW5wdXQgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbXCJwaXBlXCIsIG91dHB1dCwgb3V0cHV0XSB9KVxuICAgICAgICA6IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbb3B0aW9ucy5pbmhlcml0SW5wdXQgPyBcImluaGVyaXRcIiA6IFwiaWdub3JlXCIsIG91dHB1dCwgb3V0cHV0XSB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBvcHRpb25zLm93bmVyPy5zcGF3bmVkKHVuZGVmaW5lZCwgZmFsc2UpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIGxldCBmYWlsdXJlOiBFcnJvciB8IHVuZGVmaW5lZDtcbiAgbGV0IGRlc2NlbmRhbnRzQWN0aXZlID0gZmFsc2U7XG4gIGNvbnN0IHN0b3AgPSAoc2lnbmFsOiBOb2RlSlMuU2lnbmFscykgPT4ge1xuICAgIGlmIChjaGlsZC5waWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgc2lnbmFsKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRVNSQ0hcIilcbiAgICAgICAgZmFpbHVyZSA/Pz0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgdGVybWluYXRpb24gZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgdGltZXJzOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PltdID0gW107XG4gIGlmIChvcHRpb25zLnN0b3BEZXNjZW5kYW50c09uRXhpdClcbiAgICBjaGlsZC5vbmNlKFwiZXhpdFwiLCAoKSA9PiB7XG4gICAgICBzdG9wKFwiU0lHVEVSTVwiKTtcbiAgICAgIHRpbWVycy5wdXNoKFxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICAgICAgfSwgMjAwMCksXG4gICAgICApO1xuICAgIH0pO1xuICBjb25zdCBhYm9ydCA9ICgpID0+IHtcbiAgICBzdG9wKFwiU0lHSU5UXCIpO1xuICAgIHRpbWVycy5wdXNoKFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdURVJNXCIpO1xuICAgICAgfSwgNTAwMCksXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgICB9LCAxMDAwMCksXG4gICAgKTtcbiAgfTtcbiAgY2hpbGQub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IHtcbiAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgfSk7XG4gIGNoaWxkLnN0ZGluPy5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgIGZhaWx1cmUgPz89IGVycm9yO1xuICB9KTtcbiAgY29uc3QgY2xvc2VkID0gbmV3IFByb21pc2U8Q2hpbGRPdXRjb21lPigocmVzb2x2ZSkgPT4ge1xuICAgIGNoaWxkLm9uY2UoXCJjbG9zZVwiLCAoc3RhdHVzLCBzaWduYWwpID0+IHtcbiAgICAgIHJlc29sdmUoeyBwaWQ6IGNoaWxkLnBpZCA/PyAwLCBzdGF0dXMsIHNpZ25hbCB9KTtcbiAgICB9KTtcbiAgfSk7XG4gIGxldCBjb21wbGV0ZWQ6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlbGVhc2VJbnB1dDogKCgpID0+IFByb21pc2U8dm9pZD4pIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbXBsZXRlZCA9IG9wdGlvbnMub3duZXI/LnNwYXduZWQoY2hpbGQucGlkLCB0cnVlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICBhd2FpdCBjbG9zZWQ7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgdHJ5IHtcbiAgICB0cnkge1xuICAgICAgY29ubmVjdE91dHB1dChjaGlsZCwgb3B0aW9ucyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWx1cmUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDaGlsZCBvdXRwdXQgc2V0dXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgICAgY2hpbGQuc3Rkb3V0Py5yZXN1bWUoKTtcbiAgICAgIGNoaWxkLnN0ZGVycj8ucmVzdW1lKCk7XG4gICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICB9XG4gICAgaWYgKGNhbmNlbGxpbmcpIHtcbiAgICAgIG9wdGlvbnMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgaWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIGFib3J0KCk7XG4gICAgfVxuICAgIHJlbGVhc2VJbnB1dCA9IGNvbm5lY3RJbnB1dChcbiAgICAgIGNoaWxkLFxuICAgICAgb3B0aW9ucy5pbnB1dCxcbiAgICAgIChlcnJvcikgPT4ge1xuICAgICAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgICAgIH0sXG4gICAgICAoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgICAgfSxcbiAgICApO1xuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBjbG9zZWQ7XG4gICAgYXdhaXQgcmVsZWFzZUlucHV0Py4oKTtcbiAgICByZWxlYXNlSW5wdXQgPSB1bmRlZmluZWQ7XG4gICAgaWYgKGNhbmNlbGxpbmcgJiYgb3B0aW9ucy5zaWduYWwuYWJvcnRlZCkgc3RvcChcIlNJR0tJTExcIik7XG4gICAgaWYgKGNoaWxkLnBpZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICAgICAgZm9yICg7Oykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHByb2Nlc3Mua2lsbCgtY2hpbGQucGlkLCAwKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSA9PT0gXCJFU1JDSFwiKSBicmVhaztcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoRGF0ZS5ub3coKSA+PSBkZWFkbGluZSkge1xuICAgICAgICAgIGRlc2NlbmRhbnRzQWN0aXZlID0gdHJ1ZTtcbiAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoXCJDaGlsZCBkZXNjZW5kYW50cyByZW1haW4gYWN0aXZlOyBwcmVzZXJ2aW5nIG93bmVkIHNjcmF0Y2hcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgZGVsYXkoMTApO1xuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgaWYgKCFkZXNjZW5kYW50c0FjdGl2ZSkgY29tcGxldGVkPy4oKTtcbiAgICB9IGNhdGNoIChjYXVzZSkge1xuICAgICAgY29uc3Qgb3duZXJzaGlwID0gY2F1c2UgaW5zdGFuY2VvZiBFcnJvciA/IGNhdXNlIDogbmV3IEVycm9yKFwiQ2hpbGQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZSB9KTtcbiAgICAgIGZhaWx1cmUgPSBmYWlsdXJlXG4gICAgICAgID8gbmV3IEFnZ3JlZ2F0ZUVycm9yKFtmYWlsdXJlLCBvd25lcnNoaXBdLCBcIkNoaWxkIGV4ZWN1dGlvbiBhbmQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZTogZmFpbHVyZSB9KVxuICAgICAgICA6IG93bmVyc2hpcDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLm91dGNvbWUsXG4gICAgICAuLi4oZmFpbHVyZSA/IHsgZXJyb3I6IGZhaWx1cmUgfSA6IHt9KSxcbiAgICAgIC4uLihkZXNjZW5kYW50c0FjdGl2ZSA/IHsgZGVzY2VuZGFudHNBY3RpdmU6IHRydWUgfSA6IHt9KSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IHJlbGVhc2VJbnB1dD8uKCk7XG4gICAgb3B0aW9ucy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0KTtcbiAgICBmb3IgKGNvbnN0IHRpbWVyIG9mIHRpbWVycykgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfVxufVxuXG4vKiogQ2FwdHVyZSBvbmx5IHNtYWxsIHByb3RvY29sL3F1ZXJ5IG91dHB1dC4gRWZmZWN0ZnVsIHZlcmJvc2UgY29tbWFuZHMgc2hvdWxkIHJldGFpbiBzdHJlYW1lZCBsb2dzIGluc3RlYWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FwdHVyZU93bmVkQ2hpbGQoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IE9taXQ8T3duZWRDaGlsZE9wdGlvbnMsIFwib3V0cHV0XCIgfCBcImluaGVyaXRPdXRwdXRcIj4sXG4gIGxpbWl0ID0gMTAyNCAqIDEwMjQsXG4pIHtcbiAgY29uc3Qgc3Rkb3V0OiBCdWZmZXJbXSA9IFtdLFxuICAgIHN0ZGVycjogQnVmZmVyW10gPSBbXTtcbiAgbGV0IGJ5dGVzID0gMDtcbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgYXJncywge1xuICAgIC4uLm9wdGlvbnMsXG4gICAgb3V0cHV0OiAob3V0LCBlcnIpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW3N0cmVhbSwgY2h1bmtzXSBvZiBbXG4gICAgICAgIFtvdXQsIHN0ZG91dF0sXG4gICAgICAgIFtlcnIsIHN0ZGVycl0sXG4gICAgICBdIGFzIGNvbnN0KVxuICAgICAgICBzdHJlYW0ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICAgICAgYnl0ZXMgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgIGlmIChieXRlcyA8PSBsaW1pdCkgY2h1bmtzLnB1c2goY2h1bmspO1xuICAgICAgICB9KTtcbiAgICB9LFxuICB9KTtcbiAgcmV0dXJuIHtcbiAgICAuLi5vdXRjb21lLFxuICAgIC4uLihieXRlcyA+IGxpbWl0ID8geyBlcnJvcjogbmV3IEVycm9yKGBDYXB0dXJlZCBjb21tYW5kIG91dHB1dCBleGNlZWRzICR7U3RyaW5nKGxpbWl0KX0gYnl0ZXNgKSB9IDoge30pLFxuICAgIHN0ZG91dDogQnVmZmVyLmNvbmNhdChzdGRvdXQpLnRvU3RyaW5nKFwidXRmOFwiKSxcbiAgICBzdGRlcnI6IEJ1ZmZlci5jb25jYXQoc3RkZXJyKS50b1N0cmluZyhcInV0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SyxNQUFNO0FBQUEsUUFDWixDQUFDLEtBQUssTUFBTTtBQUFBLE1BQ2Q7QUFDRSxlQUFPLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQ25DLG1CQUFTLE1BQU07QUFDZixjQUFJLFNBQVMsTUFBTyxRQUFPLEtBQUssS0FBSztBQUFBLFFBQ3ZDLENBQUM7QUFBQSxJQUNMO0FBQUEsRUFDRixDQUFDO0FBQ0QsU0FBTztBQUFBLElBQ0wsR0FBRztBQUFBLElBQ0gsR0FBSSxRQUFRLFFBQVEsRUFBRSxPQUFPLElBQUksTUFBTSxtQ0FBbUMsT0FBTyxLQUFLLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQztBQUFBLElBQ3RHLFFBQVEsT0FBTyxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFBQSxJQUM3QyxRQUFRLE9BQU8sT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNO0FBQUEsRUFDL0M7QUFDRjsiLCJuYW1lcyI6WyJmYWlsdXJlIl0sImZpbGUiOiJhcHAvc3JjL2NvcmUvcnVudGltZS9vd25lZC1jaGlsZC5tanMifQ==
