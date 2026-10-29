// Generated from owned-child.mts; edit the TypeScript source.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import { spawnWindowsProcess } from "./windows-process.mjs";
import { combineFailures } from "./diagnostic-errors.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm93bmVkLWNoaWxkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NCeVN0ZGlvIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSwgV3JpdGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgZGVsYXkgfSBmcm9tIFwibm9kZTp0aW1lcnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGZpbmlzaGVkIH0gZnJvbSBcIm5vZGU6c3RyZWFtL3Byb21pc2VzXCI7XG5pbXBvcnQgdHlwZSB7IFByb2Nlc3NMb2NrIH0gZnJvbSBcIi4uL3NyYy9wcm9jZXNzLWxvY2suanNcIjtcbmltcG9ydCB7IHNwYXduV2luZG93c1Byb2Nlc3MsIHR5cGUgV2luZG93c1Byb2Nlc3MgfSBmcm9tIFwiLi93aW5kb3dzLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBjb21iaW5lRmFpbHVyZXMgfSBmcm9tIFwiLi9kaWFnbm9zdGljLWVycm9ycy5tanNcIjtcblxudHlwZSBPd25lZENoaWxkID0gQ2hpbGRQcm9jZXNzQnlTdGRpbzxXcml0YWJsZSB8IG51bGwsIFJlYWRhYmxlIHwgbnVsbCwgUmVhZGFibGUgfCBudWxsPjtcblxuZXhwb3J0IGludGVyZmFjZSBDaGlsZE91dGNvbWUge1xuICBwaWQ6IG51bWJlcjtcbiAgc3RhdHVzOiBudW1iZXIgfCBudWxsO1xuICBzaWduYWw6IE5vZGVKUy5TaWduYWxzIHwgbnVsbDtcbiAgZXJyb3I/OiBFcnJvcjtcbiAgZGVzY2VuZGFudHNBY3RpdmU/OiBib29sZWFuO1xufVxuZXhwb3J0IGludGVyZmFjZSBPd25lZENoaWxkT3B0aW9ucyB7XG4gIGN3ZDogc3RyaW5nO1xuICBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52O1xuICBzaWduYWw6IEFib3J0U2lnbmFsO1xuICBvd25lcj86IFByb2Nlc3NMb2NrO1xuICBpbnB1dD86IHN0cmluZyB8IFJlYWRhYmxlO1xuICBpbmhlcml0SW5wdXQ/OiBib29sZWFuO1xuICBpbmhlcml0T3V0cHV0PzogYm9vbGVhbjtcbiAgc2h1dGRvd24/OiBcImNhbmNlbFwiIHwgXCJkcmFpblwiO1xuICBzdG9wRGVzY2VuZGFudHNPbkV4aXQ/OiBib29sZWFuO1xuICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM/OiBib29sZWFuO1xuICBvdXRwdXQ/OiAoc3Rkb3V0OiBSZWFkYWJsZSwgc3RkZXJyOiBSZWFkYWJsZSkgPT4gdm9pZDtcbn1cbmV4cG9ydCBmdW5jdGlvbiBwcm9jZXNzQ2FuY2VsbGF0aW9uKCkge1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBpbnRlcnJ1cHQgPSAoKSA9PiB7XG4gICAgY29udHJvbGxlci5hYm9ydCgpO1xuICB9O1xuICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIGludGVycnVwdCk7XG4gIHJldHVybiB7XG4gICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICBjbG9zZTogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgaW50ZXJydXB0KTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNvbm5lY3RJbnB1dChcbiAgY2hpbGQ6IE93bmVkQ2hpbGQsXG4gIGlucHV0OiBPd25lZENoaWxkT3B0aW9uc1tcImlucHV0XCJdLFxuICBmYWlsOiAoZXJyb3I6IEVycm9yKSA9PiB2b2lkLFxuICBzdG9wOiAoKSA9PiB2b2lkLFxuKTogKCgpID0+IFByb21pc2U8dm9pZD4pIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiBpbnB1dCA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNoaWxkLnN0ZGluPy5lbmQoaW5wdXQpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIWlucHV0KSByZXR1cm47XG4gIGNvbnN0IGZhaWxlZCA9IChlcnJvcjogRXJyb3IpID0+IHtcbiAgICBmYWlsKGVycm9yKTtcbiAgICBpZiAoY2hpbGQuZXhpdENvZGUgPT09IG51bGwgJiYgY2hpbGQuc2lnbmFsQ29kZSA9PT0gbnVsbCkgc3RvcCgpO1xuICB9O1xuICBpbnB1dC5vbmNlKFwiZXJyb3JcIiwgZmFpbGVkKTtcbiAgY2hpbGQuc3RkaW4/Lm9uY2UoXCJlcnJvclwiLCBmYWlsZWQpO1xuICBjb25zdCBjbG9zZWQgPSBmaW5pc2hlZChpbnB1dCwgeyBjbGVhbnVwOiB0cnVlLCByZWFkYWJsZTogdHJ1ZSwgd3JpdGFibGU6IGZhbHNlIH0pLmNhdGNoKChlcnJvcjogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlICE9PSBcIkVSUl9TVFJFQU1fUFJFTUFUVVJFX0NMT1NFXCIpXG4gICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIkNoaWxkIGlucHV0IGNsZWFudXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pKTtcbiAgfSk7XG4gIGlmIChjaGlsZC5zdGRpbikgaW5wdXQucGlwZShjaGlsZC5zdGRpbik7XG4gIHJldHVybiBhc3luYyAoKSA9PiB7XG4gICAgaWYgKGNoaWxkLnN0ZGluKSBpbnB1dC51bnBpcGUoY2hpbGQuc3RkaW4pO1xuICAgIGlucHV0LmRlc3Ryb3koKTtcbiAgICBhd2FpdCBjbG9zZWQ7XG4gICAgaW5wdXQucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBmYWlsZWQpO1xuICAgIGNoaWxkLnN0ZGluPy5yZW1vdmVMaXN0ZW5lcihcImVycm9yXCIsIGZhaWxlZCk7XG4gIH07XG59XG5mdW5jdGlvbiBjb25uZWN0T3V0cHV0KGNoaWxkOiBPd25lZENoaWxkLCBvcHRpb25zOiBPd25lZENoaWxkT3B0aW9ucyk6IHZvaWQge1xuICBpZiAob3B0aW9ucy5pbmhlcml0T3V0cHV0KSByZXR1cm47XG4gIGlmICghY2hpbGQuc3Rkb3V0IHx8ICFjaGlsZC5zdGRlcnIpIHRocm93IG5ldyBFcnJvcihcIk93bmVkIGNvbW1hbmQgb3V0cHV0IHJlcXVpcmVzIHJlYWRhYmxlIHBpcGVzXCIpO1xuICBpZiAob3B0aW9ucy5vdXRwdXQpIG9wdGlvbnMub3V0cHV0KGNoaWxkLnN0ZG91dCwgY2hpbGQuc3RkZXJyKTtcbiAgZWxzZSB7XG4gICAgY2hpbGQuc3Rkb3V0LnBpcGUocHJvY2Vzcy5zdGRvdXQsIHsgZW5kOiBmYWxzZSB9KTtcbiAgICBjaGlsZC5zdGRlcnIucGlwZShwcm9jZXNzLnN0ZGVyciwgeyBlbmQ6IGZhbHNlIH0pO1xuICB9XG59XG5cbi8qKiBUaGUgc3VwZXJ2aXNvciByZXRhaW5zIGEgam9iIGhhbmRsZSB1bnRpbCBhbGwgZGVzY2VuZGFudHMgYXJlIGdvbmU7IFBJRCBleGl0IGlzIG5vdCBkcmFpbmFnZSBwcm9vZi4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1bldpbmRvd3NPd25lZENoaWxkKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPd25lZENoaWxkT3B0aW9ucyxcbik6IFByb21pc2U8Q2hpbGRPdXRjb21lPiB7XG4gIG9wdGlvbnMub3duZXI/LmJlZm9yZVNwYXduKCk7XG4gIGxldCBydW5uaW5nOiBXaW5kb3dzUHJvY2VzcztcbiAgdHJ5IHtcbiAgICBydW5uaW5nID0gYXdhaXQgc3Bhd25XaW5kb3dzUHJvY2Vzcyhjb21tYW5kLCBhcmdzLCB7XG4gICAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgICAgZW52OiBvcHRpb25zLmVudixcbiAgICAgIHN0ZGluOiBvcHRpb25zLmlucHV0ICE9PSB1bmRlZmluZWQgPyBcInBpcGVcIiA6IG9wdGlvbnMuaW5oZXJpdElucHV0ID8gXCJpbmhlcml0XCIgOiBcImlnbm9yZVwiLFxuICAgICAgb3V0cHV0OiBvcHRpb25zLmluaGVyaXRPdXRwdXQgPyBcImluaGVyaXRcIiA6IFwicGlwZVwiLFxuICAgICAgLi4uKG9wdGlvbnMud2luZG93c1ZlcmJhdGltQXJndW1lbnRzID09PSB1bmRlZmluZWRcbiAgICAgICAgPyB7fVxuICAgICAgICA6IHsgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiBvcHRpb25zLndpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyB9KSxcbiAgICAgIC4uLihvcHRpb25zLnN0b3BEZXNjZW5kYW50c09uRXhpdCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHN0b3BEZXNjZW5kYW50c09uRXhpdDogb3B0aW9ucy5zdG9wRGVzY2VuZGFudHNPbkV4aXQgfSksXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGZhaWx1cmUpIHtcbiAgICB0cnkge1xuICAgICAgb3B0aW9ucy5vd25lcj8uc3Bhd25lZCh1bmRlZmluZWQsIGZhbHNlKTtcbiAgICB9IGNhdGNoIChjbGVhbnVwKSB7XG4gICAgICB0aHJvdyBjb21iaW5lRmFpbHVyZXMoZmFpbHVyZSwgY2xlYW51cCwgXCJXaW5kb3dzIHByb2Nlc3MgcHJlcGFyYXRpb24gYW5kIG93bmVyc2hpcCBjbGVhbnVwIGZhaWxlZFwiKTtcbiAgICB9XG4gICAgdGhyb3cgZmFpbHVyZTtcbiAgfVxuICBjb25zdCBjaGlsZCA9IHJ1bm5pbmcuY2hpbGQ7XG4gIGxldCBmYWlsdXJlOiBFcnJvciB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcmVwb3J0ZWQgPSBuZXcgU2V0PEVycm9yPigpO1xuICBjb25zdCBmYWlsID0gKGVycm9yOiBFcnJvcikgPT4ge1xuICAgIGlmIChyZXBvcnRlZC5oYXMoZXJyb3IpKSByZXR1cm47XG4gICAgcmVwb3J0ZWQuYWRkKGVycm9yKTtcbiAgICBmYWlsdXJlID0gZmFpbHVyZSA/IGNvbWJpbmVGYWlsdXJlcyhmYWlsdXJlLCBlcnJvciwgXCJXaW5kb3dzIGNvbW1hbmQgYW5kIGNsZWFudXAgZmFpbGVkXCIpIDogZXJyb3I7XG4gIH07XG4gIGNoaWxkLm9uKFwiZXJyb3JcIiwgZmFpbCk7XG4gIGNoaWxkLnN0ZGluPy5vbihcImVycm9yXCIsIGZhaWwpO1xuICBsZXQgY29tcGxldGVkOiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQ7XG4gIGxldCByZWxlYXNlSW5wdXQ6ICgoKSA9PiBQcm9taXNlPHZvaWQ+KSB8IHVuZGVmaW5lZDtcbiAgY29uc3QgY2FuY2VsbGluZyA9IG9wdGlvbnMuc2h1dGRvd24gIT09IFwiZHJhaW5cIjtcbiAgY29uc3QgY2FuY2VsID0gKCkgPT4ge1xuICAgIHJ1bm5pbmcuY2FuY2VsKCk7XG4gIH07XG4gIHRyeSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbXBsZXRlZCA9IG9wdGlvbnMub3duZXI/LnNwYXduZWQoY2hpbGQucGlkLCBmYWxzZSwgdHJ1ZSk7XG4gICAgICBjb25uZWN0T3V0cHV0KGNoaWxkLCBvcHRpb25zKTtcbiAgICAgIHJlbGVhc2VJbnB1dCA9IGNvbm5lY3RJbnB1dChjaGlsZCwgb3B0aW9ucy5pbnB1dCwgZmFpbCwgY2FuY2VsKTtcbiAgICAgIGlmIChjYW5jZWxsaW5nKSB7XG4gICAgICAgIG9wdGlvbnMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYW5jZWwsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgaWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIGNhbmNlbCgpO1xuICAgICAgfVxuICAgICAgYXdhaXQgcnVubmluZy5hZG1pdCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIldpbmRvd3MgY29tbWFuZCBzZXR1cCBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICAgICAgY2hpbGQuc3Rkb3V0Py5yZXN1bWUoKTtcbiAgICAgIGNoaWxkLnN0ZGVycj8ucmVzdW1lKCk7XG4gICAgICBjYW5jZWwoKTtcbiAgICB9XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bm5pbmcuY29tcGxldGlvbjtcbiAgICBpZiAob3V0Y29tZS5lcnJvcikgZmFpbChvdXRjb21lLmVycm9yKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgcmVsZWFzZUlucHV0Py4oKTtcbiAgICAgIHJlbGVhc2VJbnB1dCA9IHVuZGVmaW5lZDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgZmFpbChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJXaW5kb3dzIGNvbW1hbmQgaW5wdXQgY2xlYW51cCBmYWlsZWRcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICAgIH1cbiAgICBpZiAoIW91dGNvbWUuam9iRW1wdHkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIG9wdGlvbnMub3duZXI/Lm1hcmtVbmNlcnRhaW4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGZhaWwoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2Fubm90IHJldGFpbiB1bmNlcnRhaW4gcHJvY2VzcyBvd25lcnNoaXBcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICAgICAgfVxuICAgICAgZmFpbChuZXcgRXJyb3IoYFdpbmRvd3MgcHJvY2VzcyB0ZXJtaW5hdGlvbiBpcyB1bmNlcnRhaW47IHByZXNlcnZpbmcgJHtydW5uaW5nLmRpcmVjdG9yeX1gKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bm5pbmcuZGlzcG9zZSgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZmFpbChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJXaW5kb3dzIHByb2Nlc3Mgc2NyYXRjaCBjbGVhbnVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KSk7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBjb21wbGV0ZWQ/LigpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZmFpbChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXCJXaW5kb3dzIHByb2Nlc3Mgb3duZXJzaGlwIGNsZWFudXAgZmFpbGVkXCIsIHsgY2F1c2U6IGVycm9yIH0pKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHBpZDogb3V0Y29tZS5waWQsXG4gICAgICBzdGF0dXM6IG91dGNvbWUuc3RhdHVzLFxuICAgICAgc2lnbmFsOiBudWxsLFxuICAgICAgLi4uKGZhaWx1cmUgPyB7IGVycm9yOiBmYWlsdXJlIH0gOiB7fSksXG4gICAgICAuLi4oIW91dGNvbWUuam9iRW1wdHkgPyB7IGRlc2NlbmRhbnRzQWN0aXZlOiB0cnVlIH0gOiB7fSksXG4gICAgfTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCByZWxlYXNlSW5wdXQ/LigpO1xuICAgIG9wdGlvbnMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYW5jZWwpO1xuICB9XG59XG5cbi8qKiBPd24gdGhlIGNvbXBsZXRlIGNoaWxkIGdyb3VwIHRocm91Z2ggY2FuY2VsbGF0aW9uIGFuZCByZWFwaW5nLCBiZWZvcmUgaXRzIHNjcmF0Y2ggZGF0YSBjYW4gYmUgcmVsZWFzZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuT3duZWRDaGlsZChcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogT3duZWRDaGlsZE9wdGlvbnMsXG4pOiBQcm9taXNlPENoaWxkT3V0Y29tZT4ge1xuICBvcHRpb25zLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICBpZiAob3B0aW9ucy5pbnB1dCAhPT0gdW5kZWZpbmVkICYmIG9wdGlvbnMuaW5oZXJpdElucHV0KVxuICAgIHRocm93IG5ldyBFcnJvcihcIkNoaWxkIGlucHV0IG11c3QgYmUgc3VwcGxpZWQgb3IgaW5oZXJpdGVkLCBub3QgYm90aFwiKTtcbiAgaWYgKG9wdGlvbnMuaW5oZXJpdE91dHB1dCAmJiBvcHRpb25zLm91dHB1dCkgdGhyb3cgbmV3IEVycm9yKFwiQ2hpbGQgb3V0cHV0IG11c3QgYmUgY2FwdHVyZWQgb3IgaW5oZXJpdGVkLCBub3QgYm90aFwiKTtcbiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikgcmV0dXJuIHJ1bldpbmRvd3NPd25lZENoaWxkKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpO1xuICBvcHRpb25zLm93bmVyPy5iZWZvcmVTcGF3bigpO1xuICBjb25zdCBjYW5jZWxsaW5nID0gb3B0aW9ucy5zaHV0ZG93biAhPT0gXCJkcmFpblwiO1xuICBsZXQgY2hpbGQ6IE93bmVkQ2hpbGQ7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2V0dGluZ3MgPSB7XG4gICAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgICAgZW52OiBvcHRpb25zLmVudixcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgLy8gQ1JFQVRFX05PX1dJTkRPVyB3b3VsZCBkZXRhY2ggY29tcGlsZXIgd29ya2VycyBmcm9tIHRoZWlyIHByaXZhdGUgVVRGLTggY29uc29sZS5cbiAgICAgIHdpbmRvd3NIaWRlOiBvcHRpb25zLmVudi5XT1JLQkVOQ0hfTkFUSVZFX1VURjhfQ09OU09MRSAhPT0gXCIxXCIsXG4gICAgICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IG9wdGlvbnMud2luZG93c1ZlcmJhdGltQXJndW1lbnRzID8/IGZhbHNlLFxuICAgIH07XG4gICAgY29uc3Qgb3V0cHV0ID0gb3B0aW9ucy5pbmhlcml0T3V0cHV0ID8gXCJpbmhlcml0XCIgOiBcInBpcGVcIjtcbiAgICBjaGlsZCA9XG4gICAgICBvcHRpb25zLmlucHV0ICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyBzcGF3bihjb21tYW5kLCBhcmdzLCB7IC4uLnNldHRpbmdzLCBzdGRpbzogW1wicGlwZVwiLCBvdXRwdXQsIG91dHB1dF0gfSlcbiAgICAgICAgOiBzcGF3bihjb21tYW5kLCBhcmdzLCB7IC4uLnNldHRpbmdzLCBzdGRpbzogW29wdGlvbnMuaW5oZXJpdElucHV0ID8gXCJpbmhlcml0XCIgOiBcImlnbm9yZVwiLCBvdXRwdXQsIG91dHB1dF0gfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgb3B0aW9ucy5vd25lcj8uc3Bhd25lZCh1bmRlZmluZWQsIGZhbHNlKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICBsZXQgZmFpbHVyZTogRXJyb3IgfCB1bmRlZmluZWQ7XG4gIGxldCBkZXNjZW5kYW50c0FjdGl2ZSA9IGZhbHNlO1xuICBjb25zdCBzdG9wID0gKHNpZ25hbDogTm9kZUpTLlNpZ25hbHMpID0+IHtcbiAgICBpZiAoY2hpbGQucGlkID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5raWxsKC1jaGlsZC5waWQsIHNpZ25hbCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlICE9PSBcIkVTUkNIXCIpXG4gICAgICAgIGZhaWx1cmUgPz89IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIkNoaWxkIHRlcm1pbmF0aW9uIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IHRpbWVyczogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD5bXSA9IFtdO1xuICBpZiAob3B0aW9ucy5zdG9wRGVzY2VuZGFudHNPbkV4aXQpXG4gICAgY2hpbGQub25jZShcImV4aXRcIiwgKCkgPT4ge1xuICAgICAgc3RvcChcIlNJR1RFUk1cIik7XG4gICAgICB0aW1lcnMucHVzaChcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgICAgIH0sIDIwMDApLFxuICAgICAgKTtcbiAgICB9KTtcbiAgY29uc3QgYWJvcnQgPSAoKSA9PiB7XG4gICAgc3RvcChcIlNJR0lOVFwiKTtcbiAgICB0aW1lcnMucHVzaChcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBzdG9wKFwiU0lHVEVSTVwiKTtcbiAgICAgIH0sIDUwMDApLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgICAgfSwgMTAwMDApLFxuICAgICk7XG4gIH07XG4gIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycm9yKSA9PiB7XG4gICAgZmFpbHVyZSA/Pz0gZXJyb3I7XG4gIH0pO1xuICBjaGlsZC5zdGRpbj8ub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IHtcbiAgICBmYWlsdXJlID8/PSBlcnJvcjtcbiAgfSk7XG4gIGNvbnN0IGNsb3NlZCA9IG5ldyBQcm9taXNlPENoaWxkT3V0Y29tZT4oKHJlc29sdmUpID0+IHtcbiAgICBjaGlsZC5vbmNlKFwiY2xvc2VcIiwgKHN0YXR1cywgc2lnbmFsKSA9PiB7XG4gICAgICByZXNvbHZlKHsgcGlkOiBjaGlsZC5waWQgPz8gMCwgc3RhdHVzLCBzaWduYWwgfSk7XG4gICAgfSk7XG4gIH0pO1xuICBsZXQgY29tcGxldGVkOiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQ7XG4gIGxldCByZWxlYXNlSW5wdXQ6ICgoKSA9PiBQcm9taXNlPHZvaWQ+KSB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb21wbGV0ZWQgPSBvcHRpb25zLm93bmVyPy5zcGF3bmVkKGNoaWxkLnBpZCwgdHJ1ZSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgYXdhaXQgY2xvc2VkO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIHRyeSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbm5lY3RPdXRwdXQoY2hpbGQsIG9wdGlvbnMpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsdXJlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFwiQ2hpbGQgb3V0cHV0IHNldHVwIGZhaWxlZFwiLCB7IGNhdXNlOiBlcnJvciB9KTtcbiAgICAgIGNoaWxkLnN0ZG91dD8ucmVzdW1lKCk7XG4gICAgICBjaGlsZC5zdGRlcnI/LnJlc3VtZSgpO1xuICAgICAgc3RvcChcIlNJR0tJTExcIik7XG4gICAgfVxuICAgIGlmIChjYW5jZWxsaW5nKSB7XG4gICAgICBvcHRpb25zLnNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGlmIChvcHRpb25zLnNpZ25hbC5hYm9ydGVkKSBhYm9ydCgpO1xuICAgIH1cbiAgICByZWxlYXNlSW5wdXQgPSBjb25uZWN0SW5wdXQoXG4gICAgICBjaGlsZCxcbiAgICAgIG9wdGlvbnMuaW5wdXQsXG4gICAgICAoZXJyb3IpID0+IHtcbiAgICAgICAgZmFpbHVyZSA/Pz0gZXJyb3I7XG4gICAgICB9LFxuICAgICAgKCkgPT4ge1xuICAgICAgICBzdG9wKFwiU0lHS0lMTFwiKTtcbiAgICAgIH0sXG4gICAgKTtcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgY2xvc2VkO1xuICAgIGF3YWl0IHJlbGVhc2VJbnB1dD8uKCk7XG4gICAgcmVsZWFzZUlucHV0ID0gdW5kZWZpbmVkO1xuICAgIGlmIChjYW5jZWxsaW5nICYmIG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIHN0b3AoXCJTSUdLSUxMXCIpO1xuICAgIGlmIChjaGlsZC5waWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgICAgIGZvciAoOzspIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgMCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPT09IFwiRVNSQ0hcIikgYnJlYWs7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKERhdGUubm93KCkgPj0gZGVhZGxpbmUpIHtcbiAgICAgICAgICBkZXNjZW5kYW50c0FjdGl2ZSA9IHRydWU7XG4gICAgICAgICAgZmFpbHVyZSA/Pz0gbmV3IEVycm9yKFwiQ2hpbGQgZGVzY2VuZGFudHMgcmVtYWluIGFjdGl2ZTsgcHJlc2VydmluZyBvd25lZCBzY3JhdGNoXCIpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGRlbGF5KDEwKTtcbiAgICAgIH1cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGlmICghZGVzY2VuZGFudHNBY3RpdmUpIGNvbXBsZXRlZD8uKCk7XG4gICAgfSBjYXRjaCAoY2F1c2UpIHtcbiAgICAgIGNvbnN0IG93bmVyc2hpcCA9IGNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyBjYXVzZSA6IG5ldyBFcnJvcihcIkNoaWxkIG93bmVyc2hpcCB1cGRhdGUgZmFpbGVkXCIsIHsgY2F1c2UgfSk7XG4gICAgICBmYWlsdXJlID0gZmFpbHVyZVxuICAgICAgICA/IG5ldyBBZ2dyZWdhdGVFcnJvcihbZmFpbHVyZSwgb3duZXJzaGlwXSwgXCJDaGlsZCBleGVjdXRpb24gYW5kIG93bmVyc2hpcCB1cGRhdGUgZmFpbGVkXCIsIHsgY2F1c2U6IGZhaWx1cmUgfSlcbiAgICAgICAgOiBvd25lcnNoaXA7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAuLi5vdXRjb21lLFxuICAgICAgLi4uKGZhaWx1cmUgPyB7IGVycm9yOiBmYWlsdXJlIH0gOiB7fSksXG4gICAgICAuLi4oZGVzY2VuZGFudHNBY3RpdmUgPyB7IGRlc2NlbmRhbnRzQWN0aXZlOiB0cnVlIH0gOiB7fSksXG4gICAgfTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCByZWxlYXNlSW5wdXQ/LigpO1xuICAgIG9wdGlvbnMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydCk7XG4gICAgZm9yIChjb25zdCB0aW1lciBvZiB0aW1lcnMpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gIH1cbn1cblxuLyoqIENhcHR1cmUgb25seSBzbWFsbCBwcm90b2NvbC9xdWVyeSBvdXRwdXQuIEVmZmVjdGZ1bCB2ZXJib3NlIGNvbW1hbmRzIHNob3VsZCByZXRhaW4gc3RyZWFtZWQgbG9ncyBpbnN0ZWFkLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVPd25lZENoaWxkKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPbWl0PE93bmVkQ2hpbGRPcHRpb25zLCBcIm91dHB1dFwiIHwgXCJpbmhlcml0T3V0cHV0XCI+LFxuICBsaW1pdCA9IDEwMjQgKiAxMDI0LFxuKSB7XG4gIGNvbnN0IHN0ZG91dDogQnVmZmVyW10gPSBbXSxcbiAgICBzdGRlcnI6IEJ1ZmZlcltdID0gW107XG4gIGxldCBieXRlcyA9IDA7XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBydW5Pd25lZENoaWxkKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICAuLi5vcHRpb25zLFxuICAgIG91dHB1dDogKG91dCwgZXJyKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtzdHJlYW0sIGNodW5rc10gb2YgW1xuICAgICAgICBbb3V0LCBzdGRvdXRdLFxuICAgICAgICBbZXJyLCBzdGRlcnJdLFxuICAgICAgXSBhcyBjb25zdClcbiAgICAgICAgc3RyZWFtLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgICAgIGJ5dGVzICs9IGNodW5rLmxlbmd0aDtcbiAgICAgICAgICBpZiAoYnl0ZXMgPD0gbGltaXQpIGNodW5rcy5wdXNoKGNodW5rKTtcbiAgICAgICAgfSk7XG4gICAgfSxcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgLi4ub3V0Y29tZSxcbiAgICAuLi4oYnl0ZXMgPiBsaW1pdCA/IHsgZXJyb3I6IG5ldyBFcnJvcihgQ2FwdHVyZWQgY29tbWFuZCBvdXRwdXQgZXhjZWVkcyAke1N0cmluZyhsaW1pdCl9IGJ5dGVzYCkgfSA6IHt9KSxcbiAgICBzdGRvdXQ6IEJ1ZmZlci5jb25jYXQoc3Rkb3V0KS50b1N0cmluZyhcInV0ZjhcIiksXG4gICAgc3RkZXJyOiBCdWZmZXIuY29uY2F0KHN0ZGVycikudG9TdHJpbmcoXCJ1dGY4XCIpLFxuICB9O1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxhQUF1QztBQUVoRCxTQUFTLGNBQWMsYUFBYTtBQUNwQyxTQUFTLGdCQUFnQjtBQUV6QixTQUFTLDJCQUFnRDtBQUN6RCxTQUFTLHVCQUF1QjtBQXdCekIsU0FBUyxzQkFBc0I7QUFDcEMsUUFBTSxhQUFhLElBQUksZ0JBQWdCO0FBQ3ZDLFFBQU0sWUFBWSxNQUFNO0FBQ3RCLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0EsVUFBUSxHQUFHLFVBQVUsU0FBUztBQUM5QixVQUFRLEdBQUcsV0FBVyxTQUFTO0FBQy9CLFNBQU87QUFBQSxJQUNMLFFBQVEsV0FBVztBQUFBLElBQ25CLE9BQU8sTUFBTTtBQUNYLGNBQVEsSUFBSSxVQUFVLFNBQVM7QUFDL0IsY0FBUSxJQUFJLFdBQVcsU0FBUztBQUFBLElBQ2xDO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyxhQUNQLE9BQ0EsT0FDQSxNQUNBLE1BQ21DO0FBQ25DLE1BQUksT0FBTyxVQUFVLFVBQVU7QUFDN0IsVUFBTSxPQUFPLElBQUksS0FBSztBQUN0QjtBQUFBLEVBQ0Y7QUFDQSxNQUFJLENBQUMsTUFBTztBQUNaLFFBQU0sU0FBUyxDQUFDLFVBQWlCO0FBQy9CLFNBQUssS0FBSztBQUNWLFFBQUksTUFBTSxhQUFhLFFBQVEsTUFBTSxlQUFlLEtBQU0sTUFBSztBQUFBLEVBQ2pFO0FBQ0EsUUFBTSxLQUFLLFNBQVMsTUFBTTtBQUMxQixRQUFNLE9BQU8sS0FBSyxTQUFTLE1BQU07QUFDakMsUUFBTSxTQUFTLFNBQVMsT0FBTyxFQUFFLFNBQVMsTUFBTSxVQUFVLE1BQU0s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RTtBQUFBLE1BQ2hCO0FBQUEsSUFDRjtBQUNBLFFBQUk7QUFDRixVQUFJLENBQUMsa0JBQW1CLGFBQVk7QUFBQSxJQUN0QyxTQUFTLE9BQU87QUFDZCxZQUFNLFlBQVksaUJBQWlCLFFBQVEsUUFBUSxJQUFJLE1BQU0saUNBQWlDLEVBQUUsTUFBTSxDQUFDO0FBQ3ZHLGdCQUFVLFVBQ04sSUFBSSxlQUFlLENBQUMsU0FBUyxTQUFTLEdBQUcsK0NBQStDLEVBQUUsT0FBTyxRQUFRLENBQUMsSUFDMUc7QUFBQSxJQUNOO0FBQ0EsV0FBTztBQUFBLE1BQ0wsR0FBRztBQUFBLE1BQ0gsR0FBSSxVQUFVLEVBQUUsT0FBTyxRQUFRLElBQUksQ0FBQztBQUFBLE1BQ3BDLEdBQUksb0JBQW9CLEVBQUUsbUJBQW1CLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDekQ7QUFBQSxFQUNGLFVBQUU7QUFDQSxVQUFNLGVBQWU7QUFDckIsWUFBUSxPQUFPLG9CQUFvQixTQUFTLEtBQUs7QUFDakQsZUFBVyxTQUFTLE9BQVEsY0FBYSxLQUFLO0FBQUEsRUFDaEQ7QUFDRjtBQUdBLGVBQXNCLGtCQUNwQixTQUNBLE1BQ0EsU0FDQSxRQUFRLE9BQU8sTUFDZjtBQUNBLFFBQU0sU0FBbUIsQ0FBQyxHQUN4QixTQUFtQixDQUFDO0FBQ3RCLE1BQUksUUFBUTtBQUNaLFFBQU0sVUFBVSxNQUFNLGNBQWMsU0FBUyxNQUFNO0FBQUEsSUFDakQsR0FBRztBQUFBLElBQ0gsUUFBUSxDQUFDLEtBQUssUUFBUTtBQUNwQixpQkFBVyxDQUFDLFFBQVEsTUFBTSxLQUFLO0FBQUEsUUFDN0IsQ0FBQyxLQUFLLE1BQU07QUFBQSxRQUNaLENBQUMsS0FBSyxNQUFNO0FBQUEsTUFDZDtBQUNFLGVBQU8sR0FBRyxRQUFRLENBQUMsVUFBa0I7QUFDbkMsbUJBQVMsTUFBTTtBQUNmLGNBQUksU0FBUyxNQUFPLFFBQU8sS0FBSyxLQUFLO0FBQUEsUUFDdkMsQ0FBQztBQUFBLElBQ0w7QUFBQSxFQUNGLENBQUM7QUFDRCxTQUFPO0FBQUEsSUFDTCxHQUFHO0FBQUEsSUFDSCxHQUFJLFFBQVEsUUFBUSxFQUFFLE9BQU8sSUFBSSxNQUFNLG1DQUFtQyxPQUFPLEtBQUssQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDO0FBQUEsSUFDdEcsUUFBUSxPQUFPLE9BQU8sTUFBTSxFQUFFLFNBQVMsTUFBTTtBQUFBLElBQzdDLFFBQVEsT0FBTyxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFBQSxFQUMvQztBQUNGOyIsIm5hbWVzIjpbImZhaWx1cmUiXSwiZmlsZSI6InNjcmlwdHMvb3duZWQtY2hpbGQubWpzIn0=
