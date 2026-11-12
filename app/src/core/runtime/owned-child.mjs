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
      ...options.stopDescendantsOnExit === void 0 ? {} : { stopDescendantsOnExit: options.stopDescendantsOnExit }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm93bmVkLWNoaWxkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NCeVN0ZGlvIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSwgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgZGVsYXkgfSBmcm9tIFwibm9kZTp0aW1lcnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGZpbmlzaGVkIH0gZnJvbSBcIm5vZGU6c3RyZWFtL3Byb21pc2VzXCI7XG5pbXBvcnQgdHlwZSB7IFByb2Nlc3NMb2NrIH0gZnJvbSBcIi4uL3N0b3JhZ2UvcHJvY2Vzcy1sb2NrLmpzXCI7XG5pbXBvcnQgeyBzcGF3bldpbmRvd3NQcm9jZXNzLCB0eXBlIFdpbmRvd3NQcm9jZXNzIH0gZnJvbSBcIi4vd2luZG93cy1wcm9jZXNzLm1qc1wiO1xuaW1wb3J0IHsgY29tYmluZUZhaWx1cmVzIH0gZnJvbSBcIi4uL2RpYWdub3N0aWNzL2RpYWdub3N0aWMtZXJyb3JzLm1qc1wiO1xuXG50eXBlIE93bmVkQ2hpbGQgPSBDaGlsZFByb2Nlc3NCeVN0ZGlvPFdyaXRhYmxlIHwgbnVsbCwgUmVhZGFibGUgfCBudWxsLCBSZWFkYWJsZSB8IG51bGw+O1xuXG5leHBvcnQgaW50ZXJmYWNlIENoaWxkT3V0Y29tZSB7XG4gIHBpZDogbnVtYmVyO1xuICBzdGF0dXM6IG51bWJlciB8IG51bGw7XG4gIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsO1xuICBlcnJvcj86IEVycm9yO1xuICBkZXNjZW5kYW50c0FjdGl2ZT86IGJvb2xlYW47XG59XG5leHBvcnQgaW50ZXJmYWNlIE93bmVkQ2hpbGRPcHRpb25zIHtcbiAgY3dkOiBzdHJpbmc7XG4gIGVudjogTm9kZUpTLlByb2Nlc3NFbnY7XG4gIHNpZ25hbDogQWJvcnRTaWduYWw7XG4gIG93bmVyPzogUHJvY2Vzc0xvY2s7XG4gIGlucHV0Pzogc3RyaW5nIHwgUmVhZGFibGU7XG4gIGluaGVyaXRJbnB1dD86IGJvb2xlYW47XG4gIGluaGVyaXRPdXRwdXQ/OiBib29sZWFuO1xuICBzaHV0ZG93bj86IFwiY2FuY2VsXCIgfCBcImRyYWluXCI7XG4gIHN0b3BEZXNjZW5kYW50c09uRXhpdD86IGJvb2xlYW47XG4gIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cz86IGJvb2xlYW47XG4gIG91dHB1dD86IChzdGRvdXQ6IFJlYWRhYmxlLCBzdGRlcnI6IFJlYWRhYmxlKSA9PiB2b2lkO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHByb2Nlc3NDYW5jZWxsYXRpb24oKSB7XG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IGludGVycnVwdCA9ICgpID0+IHtcbiAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gIH07XG4gIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgaW50ZXJydXB0KTtcbiAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgaW50ZXJydXB0KTtcbiAgcmV0dXJuIHtcbiAgICBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLFxuICAgIGNsb3NlOiAoKSA9PiB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY29ubmVjdElucHV0KFxuICBjaGlsZDogT3duZWRDaGlsZCxcbiAgaW5wdXQ6IE93bmVkQ2hpbGRPcHRpb25zW1wiaW5wdXRcIl0sXG4gIGZhaWw6IChlcnJvcjogRXJyb3IpID0+IHZvaWQsXG4gIHN0b3A6ICgpID0+IHZvaWQsXG4pOiAoKCkgPT4gUHJvbWlzZTx2b2lkPikgfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIGlucHV0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgY2hpbGQuc3RkaW4/LmVuZChpbnB1dCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghaW5wdXQpIHJldHVybjtcbiAgY29uc3QgZmFpbGVkID0gKGVycm9yOiBFcnJvcikgPT4ge1xuICAgIGZhaWwoZXJyb3IpO1xuICAgIGlmIChjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSBzdG9wKCk7XG4gIH07XG4gIGlucHV0Lm9uY2UoXCJlcnJvclwiLCBmYWlsZWQpO1xuICBjaGlsZC5zdGRpbj8ub25jZShcImVycm9yXCIsIGZhaWxlZCk7XG4gIGNvbnN0IGNsb3NlZCA9IGZpbmlzaGVkKGlucHV0LCB7IGNsZWFudXA6IHRydWUsIHJlYWRhYmxlOiB0cnVlLCB3cml0YWJsZTogZmFsc2UgfSkuY2F0Y2goKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRVJSX1NUUkVBTV9QUkVNQVRVUkVfQ0xPU0VcIilcbiAgICAgIGZhaWwoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgaW5wdXQgY2xlYW51cCBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICB9KTtcbiAgaWYgKGNoaWxkLnN0ZGluKSBpbnB1dC5waXBlKGNoaWxkLnN0ZGluKTtcbiAgcmV0dXJuIGFzeW5jICgpID0+IHtcbiAgICBpZiAoY2hpbGQuc3RkaW4pIGlucHV0LnVucGlwZShjaGlsZC5zdGRpbik7XG4gICAgaW5wdXQuZGVzdHJveSgpO1xuICAgIGF3YWl0IGNsb3NlZDtcbiAgICBpbnB1dC5yZW1vdmVMaXN0ZW5lcihcImVycm9yXCIsIGZhaWxlZCk7XG4gICAgY2hpbGQuc3RkaW4/LnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgZmFpbGVkKTtcbiAgfTtcbn1cbmZ1bmN0aW9uIGNvbm5lY3RPdXRwdXQoY2hpbGQ6IE93bmVkQ2hpbGQsIG9wdGlvbnM6IE93bmVkQ2hpbGRPcHRpb25zKTogdm9pZCB7XG4gIGlmIChvcHRpb25zLmluaGVyaXRPdXRwdXQpIHJldHVybjtcbiAgaWYgKCFjaGlsZC5zdGRvdXQgfHwgIWNoaWxkLnN0ZGVycikgdGhyb3cgbmV3IEVycm9yKFwiT3duZWQgY29tbWFuZCBvdXRwdXQgcmVxdWlyZXMgcmVhZGFibGUgcGlwZXNcIik7XG4gIGlmIChvcHRpb25zLm91dHB1dCkgb3B0aW9ucy5vdXRwdXQoY2hpbGQuc3Rkb3V0LCBjaGlsZC5zdGRlcnIpO1xuICBlbHNlIHtcbiAgICBjaGlsZC5zdGRvdXQucGlwZShwcm9jZXNzLnN0ZG91dCwgeyBlbmQ6IGZhbHNlIH0pO1xuICAgIGNoaWxkLnN0ZGVyci5waXBlKHByb2Nlc3Muc3RkZXJyLCB7IGVuZDogZmFsc2UgfSk7XG4gIH1cbn1cblxuLyoqIFRoZSBzdXBlcnZpc29yIHJldGFpbnMgYSBqb2IgaGFuZGxlIHVudGlsIGFsbCBkZXNjZW5kYW50cyBhcmUgZ29uZTsgUElEIGV4aXQgaXMgbm90IGRyYWluYWdlIHByb29mLiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuV2luZG93c093bmVkQ2hpbGQoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IE93bmVkQ2hpbGRPcHRpb25zLFxuKTogUHJvbWlzZTxDaGlsZE91dGNvbWU+IHtcbiAgb3B0aW9ucy5vd25lcj8uYmVmb3JlU3Bhd24oKTtcbiAgbGV0IHJ1bm5pbmc6IFdpbmRvd3NQcm9jZXNzO1xuICB0cnkge1xuICAgIHJ1bm5pbmcgPSBhd2FpdCBzcGF3bldpbmRvd3NQcm9jZXNzKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgc3RkaW46IG9wdGlvbnMuaW5wdXQgIT09IHVuZGVmaW5lZCA/IFwicGlwZVwiIDogb3B0aW9ucy5pbmhlcml0SW5wdXQgPyBcImluaGVyaXRcIiA6IFwiaWdub3JlXCIsXG4gICAgICBvdXRwdXQ6IG9wdGlvbnMuaW5oZXJpdE91dHB1dCA/IFwiaW5oZXJpdFwiIDogXCJwaXBlXCIsXG4gICAgICAuLi4ob3B0aW9ucy53aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgPT09IHVuZGVmaW5lZFxuICAgICAgICA/IHt9XG4gICAgICAgIDogeyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IG9wdGlvbnMud2luZG93c1ZlcmJhdGltQXJndW1lbnRzIH0pLFxuICAgICAgLi4uKG9wdGlvbnMuc3RvcERlc2NlbmRhbnRzT25FeGl0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgc3RvcERlc2NlbmRhbnRzT25FeGl0OiBvcHRpb25zLnN0b3BEZXNjZW5kYW50c09uRXhpdCB9KSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZmFpbHVyZSkge1xuICAgIHRyeSB7XG4gICAgICBvcHRpb25zLm93bmVyPy5zcGF3bmVkKHVuZGVmaW5lZCwgZmFsc2UpO1xuICAgIH0gY2F0Y2ggKGNsZWFudXApIHtcbiAgICAgIHRocm93IGNvbWJpbmVGYWlsdXJlcyhmYWlsdXJlLCBjbGVhbnVwLCBcIldpbmRvd3MgcHJvY2VzcyBwcmVwYXJhdGlvbiBhbmQgb3duZXJzaGlwIGNsZWFudXAgZmFpbGVkXCIpO1xuICAgIH1cbiAgICB0aHJvdyBmYWlsdXJlO1xuICB9XG4gIGNvbnN0IGNoaWxkID0gcnVubmluZy5jaGlsZDtcbiAgbGV0IGZhaWx1cmU6IEVycm9yIHwgdW5kZWZpbmVkO1xuICBjb25zdCByZXBvcnRlZCA9IG5ldyBTZXQ8RXJyb3I+KCk7XG4gIGNvbnN0IGZhaWwgPSAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgaWYgKHJlcG9ydGVkLmhhcyhlcnJvcikpIHJldHVybjtcbiAgICByZXBvcnRlZC5hZGQoZXJyb3IpO1xuICAgIGZhaWx1cmUgPSBmYWlsdXJlID8gY29tYmluZUZhaWx1cmVzKGZhaWx1cmUsIGVycm9yLCBcIldpbmRvd3MgY29tbWFuZCBhbmQgY2xlYW51cCBmYWlsZWRcIikgOiBlcnJvcjtcbiAgfTtcbiAgY2hpbGQub24oXCJlcnJvclwiLCBmYWlsKTtcbiAgY2hpbGQuc3RkaW4/Lm9uKFwiZXJyb3JcIiwgZmFpbCk7XG4gIGxldCBjb21wbGV0ZWQ6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlbGVhc2VJbnB1dDogKCgpID0+IFByb21pc2U8dm9pZD4pIHwgdW5kZWZpbmVkO1xuICBjb25zdCBjYW5jZWxsaW5nID0gb3B0aW9ucy5zaHV0ZG93biAhPT0gXCJkcmFpblwiO1xuICBjb25zdCBjYW5jZWwgPSAoKSA9PiB7XG4gICAgcnVubmluZy5jYW5jZWwoKTtcbiAgfTtcbiAgdHJ5IHtcbiAgICB0cnkge1xuICAgICAgY29tcGxldGVkID0gb3B0aW9ucy5vd25lcj8uc3Bhd25lZChjaGlsZC5waWQsIGZhbHNlLCB0cnVlKTtcbiAgICAgIGNvbm5lY3RPdXRwdXQoY2hpbGQsIG9wdGlvbnMpO1xuICAgICAgcmVsZWFzZUlucHV0ID0gY29ubmVjdElucHV0KGNoaWxkLCBvcHRpb25zLmlucHV0LCBmYWlsLCBjYW5jZWwpO1xuICAgICAgaWYgKGNhbmNlbGxpbmcpIHtcbiAgICAgICAgb3B0aW9ucy5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNhbmNlbCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICBpZiAob3B0aW9ucy5zaWduYWwuYWJvcnRlZCkgY2FuY2VsKCk7XG4gICAgICB9XG4gICAgICBhd2FpdCBydW5uaW5nLmFkbWl0KCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWwoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiV2luZG93cyBjb21tYW5kIHNldHVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgICBjaGlsZC5zdGRvdXQ/LnJlc3VtZSgpO1xuICAgICAgY2hpbGQuc3RkZXJyPy5yZXN1bWUoKTtcbiAgICAgIGNhbmNlbCgpO1xuICAgIH1cbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgcnVubmluZy5jb21wbGV0aW9uO1xuICAgIGlmIChvdXRjb21lLmVycm9yKSBmYWlsKG91dGNvbWUuZXJyb3IpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCByZWxlYXNlSW5wdXQ/LigpO1xuICAgICAgcmVsZWFzZUlucHV0ID0gdW5kZWZpbmVkO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgY29tbWFuZCBpbnB1dCBjbGVhbnVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgfVxuICAgIGlmICghb3V0Y29tZS5qb2JFbXB0eSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgb3B0aW9ucy5vd25lcj8ubWFya1VuY2VydGFpbigpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZmFpbChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDYW5ub3QgcmV0YWluIHVuY2VydGFpbiBwcm9jZXNzIG93bmVyc2hpcFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgICB9XG4gICAgICBmYWlsKG5ldyBFcnJvcihgV2luZG93cyBwcm9jZXNzIHRlcm1pbmF0aW9uIGlzIHVuY2VydGFpbjsgcHJlc2VydmluZyAke3J1bm5pbmcuZGlyZWN0b3J5fWApKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcnVubmluZy5kaXNwb3NlKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgcHJvY2VzcyBzY3JhdGNoIGNsZWFudXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pKTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbXBsZXRlZD8uKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgcHJvY2VzcyBvd25lcnNoaXAgY2xlYW51cCBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcGlkOiBvdXRjb21lLnBpZCxcbiAgICAgIHN0YXR1czogb3V0Y29tZS5zdGF0dXMsXG4gICAgICBzaWduYWw6IG51bGwsXG4gICAgICAuLi4oZmFpbHVyZSA/IHsgZXJyb3I6IGZhaWx1cmUgfSA6IHt9KSxcbiAgICAgIC4uLighb3V0Y29tZS5qb2JFbXB0eSA/IHsgZGVzY2VuZGFudHNBY3RpdmU6IHRydWUgfSA6IHt9KSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IHJlbGVhc2VJbnB1dD8uKCk7XG4gICAgb3B0aW9ucy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNhbmNlbCk7XG4gIH1cbn1cblxuLyoqIE93biB0aGUgY29tcGxldGUgY2hpbGQgZ3JvdXAgdGhyb3VnaCBjYW5jZWxsYXRpb24gYW5kIHJlYXBpbmcsIGJlZm9yZSBpdHMgc2NyYXRjaCBkYXRhIGNhbiBiZSByZWxlYXNlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5Pd25lZENoaWxkKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPd25lZENoaWxkT3B0aW9ucyxcbik6IFByb21pc2U8Q2hpbGRPdXRjb21lPiB7XG4gIG9wdGlvbnMuc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gIGlmIChvcHRpb25zLmlucHV0ICE9PSB1bmRlZmluZWQgJiYgb3B0aW9ucy5pbmhlcml0SW5wdXQpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2hpbGQgaW5wdXQgbXVzdCBiZSBzdXBwbGllZCBvciBpbmhlcml0ZWQsIG5vdCBib3RoXCIpO1xuICBpZiAob3B0aW9ucy5pbmhlcml0T3V0cHV0ICYmIG9wdGlvbnMub3V0cHV0KSB0aHJvdyBuZXcgRXJyb3IoXCJDaGlsZCBvdXRwdXQgbXVzdCBiZSBjYXB0dXJlZCBvciBpbmhlcml0ZWQsIG5vdCBib3RoXCIpO1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSByZXR1cm4gcnVuV2luZG93c093bmVkQ2hpbGQoY29tbWFuZCwgYXJncywgb3B0aW9ucyk7XG4gIG9wdGlvbnMub3duZXI/LmJlZm9yZVNwYXduKCk7XG4gIGNvbnN0IGNhbmNlbGxpbmcgPSBvcHRpb25zLnNodXRkb3duICE9PSBcImRyYWluXCI7XG4gIGxldCBjaGlsZDogT3duZWRDaGlsZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IHtcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICAvLyBDUkVBVEVfTk9fV0lORE9XIHdvdWxkIGRldGFjaCBjb21waWxlciB3b3JrZXJzIGZyb20gdGhlaXIgcHJpdmF0ZSBVVEYtOCBjb25zb2xlLlxuICAgICAgd2luZG93c0hpZGU6IG9wdGlvbnMuZW52LldPUktCRU5DSF9OQVRJVkVfVVRGOF9DT05TT0xFICE9PSBcIjFcIixcbiAgICAgIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogb3B0aW9ucy53aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgPz8gZmFsc2UsXG4gICAgfTtcbiAgICBjb25zdCBvdXRwdXQgPSBvcHRpb25zLmluaGVyaXRPdXRwdXQgPyBcImluaGVyaXRcIiA6IFwicGlwZVwiO1xuICAgIGNoaWxkID1cbiAgICAgIG9wdGlvbnMuaW5wdXQgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbXCJwaXBlXCIsIG91dHB1dCwgb3V0cHV0XSB9KVxuICAgICAgICA6IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHsgLi4uc2V0dGluZ3MsIHN0ZGlvOiBbb3B0aW9ucy5pbmhlcml0SW5wdXQgPyBcImluaGVyaXRcIiA6IFwiaWdub3JlXCIsIG91dHB1dCwgb3V0cHV0XSB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBvcHRpb25zLm93bmVyPy5zcGF3bmVkKHVuZGVmaW5lZCwgZmFsc2UpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIGxldCBmYWlsdXJlOiBFcnJvciB8IHVuZGVmaW5lZDtcbiAgbGV0IGRlc2NlbmRhbnRzQWN0aXZlID0gZmFsc2U7XG4gIGNvbnN0IHN0b3AgPSAoc2lnbmFsOiBOb2RlSlMuU2lnbmFscykgPT4ge1xuICAgIGlmIChjaGlsZC5waWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgc2lnbmFsKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgIT09IFwiRVNSQ0hcIilcbiAgICAgICAgZmFpbHVyZSA/Pz0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgdGVybWluYXRpb24gZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgdGltZXJzOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PltdID0gW107XG4gIGlmIChvcHRpb25zLnN0b3BEZXNjZW5kYW50c09uRXhpdClcbiAgICBjaGlsZC5vbmNlKFwiZXhpdFwiLCAoKSA9PiB7XG4gICAgICBzdG9wKFwiU0lHVEVSTVwiKTtcbiAgICAgIHRpbWVycy5wdXNoKFxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICAgICAgfSwgMjAwMCksXG4gICAgICApO1xuICAgIH0pO1xuICBjb25zdCBhYm9ydCA9ICgpID0+IHtcbiAgICBzdG9wKFwiU0lHSU5UXCIpO1xuICAgIHRpbWVycy5wdXNoKFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdURVJNXCIpO1xuICAgICAgfSwgNTAwMCksXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgICB9LCAxMDAwMCksXG4gICAgKTtcbiAgfTtcbiAgY2hpbGQub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IHtcbiAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgfSk7XG4gIGNoaWxkLnN0ZGluPy5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgIGZhaWx1cmUgPz89IGVycm9yO1xuICB9KTtcbiAgY29uc3QgY2xvc2VkID0gbmV3IFByb21pc2U8Q2hpbGRPdXRjb21lPigocmVzb2x2ZSkgPT4ge1xuICAgIGNoaWxkLm9uY2UoXCJjbG9zZVwiLCAoc3RhdHVzLCBzaWduYWwpID0+IHtcbiAgICAgIHJlc29sdmUoeyBwaWQ6IGNoaWxkLnBpZCA/PyAwLCBzdGF0dXMsIHNpZ25hbCB9KTtcbiAgICB9KTtcbiAgfSk7XG4gIGxldCBjb21wbGV0ZWQ6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlbGVhc2VJbnB1dDogKCgpID0+IFByb21pc2U8dm9pZD4pIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbXBsZXRlZCA9IG9wdGlvbnMub3duZXI/LnNwYXduZWQoY2hpbGQucGlkLCB0cnVlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICBhd2FpdCBjbG9zZWQ7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgdHJ5IHtcbiAgICB0cnkge1xuICAgICAgY29ubmVjdE91dHB1dChjaGlsZCwgb3B0aW9ucyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWx1cmUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJDaGlsZCBvdXRwdXQgc2V0dXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pO1xuICAgICAgY2hpbGQuc3Rkb3V0Py5yZXN1bWUoKTtcbiAgICAgIGNoaWxkLnN0ZGVycj8ucmVzdW1lKCk7XG4gICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICB9XG4gICAgaWYgKGNhbmNlbGxpbmcpIHtcbiAgICAgIG9wdGlvbnMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgaWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIGFib3J0KCk7XG4gICAgfVxuICAgIHJlbGVhc2VJbnB1dCA9IGNvbm5lY3RJbnB1dChcbiAgICAgIGNoaWxkLFxuICAgICAgb3B0aW9ucy5pbnB1dCxcbiAgICAgIChlcnJvcikgPT4ge1xuICAgICAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgICAgIH0sXG4gICAgICAoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgICAgfSxcbiAgICApO1xuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBjbG9zZWQ7XG4gICAgYXdhaXQgcmVsZWFzZUlucHV0Py4oKTtcbiAgICByZWxlYXNlSW5wdXQgPSB1bmRlZmluZWQ7XG4gICAgaWYgKGNhbmNlbGxpbmcgJiYgb3B0aW9ucy5zaWduYWwuYWJvcnRlZCkgc3RvcChcIlNJR0tJTExcIik7XG4gICAgaWYgKGNoaWxkLnBpZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICAgICAgZm9yICg7Oykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHByb2Nlc3Mua2lsbCgtY2hpbGQucGlkLCAwKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSA9PT0gXCJFU1JDSFwiKSBicmVhaztcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoRGF0ZS5ub3coKSA+PSBkZWFkbGluZSkge1xuICAgICAgICAgIGRlc2NlbmRhbnRzQWN0aXZlID0gdHJ1ZTtcbiAgICAgICAgICBmYWlsdXJlID8/PSBuZXcgRXJyb3IoXCJDaGlsZCBkZXNjZW5kYW50cyByZW1haW4gYWN0aXZlOyBwcmVzZXJ2aW5nIG93bmVkIHNjcmF0Y2hcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgZGVsYXkoMTApO1xuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgaWYgKCFkZXNjZW5kYW50c0FjdGl2ZSkgY29tcGxldGVkPy4oKTtcbiAgICB9IGNhdGNoIChjYXVzZSkge1xuICAgICAgY29uc3Qgb3duZXJzaGlwID0gY2F1c2UgaW5zdGFuY2VvZiBFcnJvciA/IGNhdXNlIDogbmV3IEVycm9yKFwiQ2hpbGQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZSB9KTtcbiAgICAgIGZhaWx1cmUgPSBmYWlsdXJlXG4gICAgICAgID8gbmV3IEFnZ3JlZ2F0ZUVycm9yKFtmYWlsdXJlLCBvd25lcnNoaXBdLCBcIkNoaWxkIGV4ZWN1dGlvbiBhbmQgb3duZXJzaGlwIHVwZGF0ZSBmYWlsZWRcIiwgeyBjYXVzZTogZmFpbHVyZSB9KVxuICAgICAgICA6IG93bmVyc2hpcDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLm91dGNvbWUsXG4gICAgICAuLi4oZmFpbHVyZSA/IHsgZXJyb3I6IGZhaWx1cmUgfSA6IHt9KSxcbiAgICAgIC4uLihkZXNjZW5kYW50c0FjdGl2ZSA/IHsgZGVzY2VuZGFudHNBY3RpdmU6IHRydWUgfSA6IHt9KSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IHJlbGVhc2VJbnB1dD8uKCk7XG4gICAgb3B0aW9ucy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0KTtcbiAgICBmb3IgKGNvbnN0IHRpbWVyIG9mIHRpbWVycykgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfVxufVxuXG4vKiogQ2FwdHVyZSBvbmx5IHNtYWxsIHByb3RvY29sL3F1ZXJ5IG91dHB1dC4gRWZmZWN0ZnVsIHZlcmJvc2UgY29tbWFuZHMgc2hvdWxkIHJldGFpbiBzdHJlYW1lZCBsb2dzIGluc3RlYWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FwdHVyZU93bmVkQ2hpbGQoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IE9taXQ8T3duZWRDaGlsZE9wdGlvbnMsIFwib3V0cHV0XCIgfCBcImluaGVyaXRPdXRwdXRcIj4sXG4gIGxpbWl0ID0gMTAyNCAqIDEwMjQsXG4pIHtcbiAgY29uc3Qgc3Rkb3V0OiBCdWZmZXJbXSA9IFtdLFxuICAgIHN0ZGVycjogQnVmZmVyW10gPSBbXTtcbiAgbGV0IGJ5dGVzID0gMDtcbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgYXJncywge1xuICAgIC4uLm9wdGlvbnMsXG4gICAgb3V0cHV0OiAob3V0LCBlcnIpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW3N0cmVhbSwgY2h1bmtzXSBvZiBbXG4gICAgICAgIFtvdXQsIHN0ZG91dF0sXG4gICAgICAgIFtlcnIsIHN0ZGVycl0sXG4gICAgICBdIGFzIGNvbnN0KVxuICAgICAgICBzdHJlYW0ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICAgICAgYnl0ZXMgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgIGlmIChieXRlcyA8PSBsaW1pdCkgY2h1bmtzLnB1c2goY2h1bmspO1xuICAgICAgICB9KTtcbiAgICB9LFxuICB9KTtcbiAgcmV0dXJuIHtcbiAgICAuLi5vdXRjb21lLFxuICAgIC4uLihieXRlcyA+IGxpbWl0ID8geyBlcnJvcjogbmV3IEVycm9yKGBDYXB0dXJlZCBjb21tYW5kIG91dHB1dCBleGNlZWRzICR7U3RyaW5nKGxpbWl0KX0gYnl0ZXNgKSB9IDoge30pLFxuICAgIHN0ZG91dDogQnVmZmVyLmNvbmNhdChzdGRvdXQpLnRvU3RyaW5nKFwidXRmOFwiKSxcbiAgICBzdGRlcnI6IEJ1ZmZlci5jb25jYXQoc3RkZXJyKS50b1N0cmluZyhcInV0ZjhcIiksXG4gIH07XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGFBQXVDO0FBRWhELFNBQVMsY0FBYyxhQUFhO0FBQ3BDLFNBQVMsZ0JBQWdCO0FBRXpCLFNBQVMsMkJBQWdEO0FBQ3pELFNBQVMsdUJBQXVCO0FBd0J6QixTQUFTLHNCQUFzQjtBQUNwQyxRQUFNLGFBQWEsSUFBSSxnQkFBZ0I7QUFDdkMsUUFBTSxZQUFZLE1BQU07QUFDdEIsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDQSxVQUFRLEdBQUcsVUFBVSxTQUFTO0FBQzlCLFVBQVEsR0FBRyxXQUFXLFNBQVM7QUFDL0IsU0FBTztBQUFBLElBQ0wsUUFBUSxXQUFXO0FBQUEsSUFDbkIsT0FBTyxNQUFNO0FBQ1gsY0FBUSxJQUFJLFVBQVUsU0FBUztBQUMvQixjQUFRLElBQUksV0FBVyxTQUFTO0FBQUEsSUFDbEM7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLGFBQ1AsT0FDQSxPQUNBLE1BQ0EsTUFDbUM7QUFDbkMsTUFBSSxPQUFPLFVBQVUsVUFBVTtBQUM3QixVQUFNLE9BQU8sSUFBSSxLQUFLO0FBQ3RCO0FBQUEsRUFDRjtBQUNBLE1BQUksQ0FBQyxNQUFPO0FBQ1osUUFBTSxTQUFTLENBQUMsVUFBaUI7QUFDL0IsU0FBSyxLQUFLO0FBQ1YsUUFBSSxNQUFNLGFBQWEsUUFBUSxNQUFNLGVBQWUsS0FBTSxNQUFLO0FBQUEsRUFDakU7QUFDQSxRQUFNLEtBQUssU0FBUyxNQUFNO0FBQzFCLFFBQU0sT0FBTyxLQUFLLFNBQVMsTUFBTTtBQUNqQyxRQUFNLFNBQVMsU0FBUyxPQUFPLEVBQUUsU0FB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QUNBLGNBQU0sTUFBTSxFQUFFO0FBQUEsTUFDaEI7QUFBQSxJQUNGO0FBQ0EsUUFBSTtBQUNGLFVBQUksQ0FBQyxrQkFBbUIsYUFBWTtBQUFBLElBQ3RDLFNBQVMsT0FBTztBQUNkLFlBQU0sWUFBWSxpQkFBaUIsUUFBUSxRQUFRLElBQUksTUFBTSxpQ0FBaUMsRUFBRSxNQUFNLENBQUM7QUFDdkcsZ0JBQVUsVUFDTixJQUFJLGVBQWUsQ0FBQyxTQUFTLFNBQVMsR0FBRywrQ0FBK0MsRUFBRSxPQUFPLFFBQVEsQ0FBQyxJQUMxRztBQUFBLElBQ047QUFDQSxXQUFPO0FBQUEsTUFDTCxHQUFHO0FBQUEsTUFDSCxHQUFJLFVBQVUsRUFBRSxPQUFPLFFBQVEsSUFBSSxDQUFDO0FBQUEsTUFDcEMsR0FBSSxvQkFBb0IsRUFBRSxtQkFBbUIsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUN6RDtBQUFBLEVBQ0YsVUFBRTtBQUNBLFVBQU0sZUFBZTtBQUNyQixZQUFRLE9BQU8sb0JBQW9CLFNBQVMsS0FBSztBQUNqRCxlQUFXLFNBQVMsT0FBUSxjQUFhLEtBQUs7QUFBQSxFQUNoRDtBQUNGO0FBR0EsZUFBc0Isa0JBQ3BCLFNBQ0EsTUFDQSxTQUNBLFFBQVEsT0FBTyxNQUNmO0FBQ0EsUUFBTSxTQUFtQixDQUFDLEdBQ3hCLFNBQW1CLENBQUM7QUFDdEIsTUFBSSxRQUFRO0FBQ1osUUFBTSxVQUFVLE1BQU0sY0FBYyxTQUFTLE1BQU07QUFBQSxJQUNqRCxHQUFHO0FBQUEsSUFDSCxRQUFRLENBQUMsS0FBSyxRQUFRO0FBQ3BCLGlCQUFXLENBQUMsUUFBUSxNQUFNLEtBQUs7QUFBQSxRQUM3QixDQUFDLEtBQUssTUFBTTtBQUFBLFFBQ1osQ0FBQyxLQUFLLE1BQU07QUFBQSxNQUNkO0FBQ0UsZUFBTyxHQUFHLFFBQVEsQ0FBQyxVQUFrQjtBQUNuQyxtQkFBUyxNQUFNO0FBQ2YsY0FBSSxTQUFTLE1BQU8sUUFBTyxLQUFLLEtBQUs7QUFBQSxRQUN2QyxDQUFDO0FBQUEsSUFDTDtBQUFBLEVBQ0YsQ0FBQztBQUNELFNBQU87QUFBQSxJQUNMLEdBQUc7QUFBQSxJQUNILEdBQUksUUFBUSxRQUFRLEVBQUUsT0FBTyxJQUFJLE1BQU0sbUNBQW1DLE9BQU8sS0FBSyxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUM7QUFBQSxJQUN0RyxRQUFRLE9BQU8sT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNO0FBQUEsSUFDN0MsUUFBUSxPQUFPLE9BQU8sTUFBTSxFQUFFLFNBQVMsTUFBTTtBQUFBLEVBQy9DO0FBQ0Y7IiwibmFtZXMiOlsiZmFpbHVyZSJdLCJmaWxlIjoiYXBwL3NyYy9jb3JlL3J1bnRpbWUvb3duZWQtY2hpbGQubWpzIn0=
