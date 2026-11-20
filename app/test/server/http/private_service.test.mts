import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redact } from "../../../src/core/diagnostics/diagnostic-text.mjs";
import { privateServiceReady } from "../../../src/server/http/private-service.ts";
import { expect, test } from "vitest";

const distribution = resolve(import.meta.dirname, "../../../..");
interface Ready {
  url: string;
  username: string;
  password: string;
  pid?: number;
}
interface Invocation {
  child: ChildProcess;
  ready: Promise<Ready>;
  waiting: Promise<void>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

test.skipIf(process.platform === "win32")(
  "private discovery reuses the listener, recovers crashes, and allows explicit background startup",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-private-service-")));
    const state = join(root, "long-state-home", "account-state".repeat(7));
    const temporary = join(root, "tmp");
    mkdirSync(temporary);
    const env = {
      ...process.env,
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_CONFIG_HOME: join(root, "config"),
      WORKBENCH_CACHE_HOME: join(root, "cache"),
      WORKBENCH_DATA_HOME: join(root, "data"),
      WORKBENCH_STATE_HOME: state,
      WORKBENCH_SYSTEM_RUNTIME_DIRECTORY: join(root, "system-runtime"),
      WORKBENCH_LOG_LEVEL: "info",
      WORKBENCH_LOG_FORMAT: "text",
      TMPDIR: temporary,
      DOCKER_HOST: `unix://${join(root, "docker.sock")}`,
    };
    const children: Invocation[] = [];
    let backgroundPid: number | undefined;
    function start(...options: string[]): Invocation {
      const child = spawn(
        process.execPath,
        [join(distribution, "bundle/main.cjs"), "serve", "--port", "0", ...options],
        {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let errors = "";
      let reported = false;
      let resolveReady!: (access: Ready) => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<Ready>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => undefined);
      let reportWaiting!: () => void;
      let rejectWaiting!: (error: Error) => void;
      const waiting = new Promise<void>((resolve, reject) => {
        reportWaiting = resolve;
        rejectWaiting = reject;
      });
      void waiting.catch(() => undefined);
      child.stderr.on("data", (chunk: Buffer) => {
        if (errors.length < 4096) errors += chunk.toString();
        if (errors.includes("web.service: waiting")) reportWaiting();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (reported) return;
        output += chunk.toString();
        const url = /^Workbench web UI: (http:\/\/127\.0\.0\.1:\d+(?:\/demonstration)?)(?=\r?\n)/m.exec(output)?.[1];
        const username = /^Sign-in username: ([^\r\n:]+)(?=\r?\n)/m.exec(output)?.[1];
        const password = /^Sign-in password: ([A-Za-z0-9_-]{43})(?=\r?\n)/m.exec(output)?.[1];
        const pid = /^Server PID: (\d+)(?=\r?\n)/m.exec(output)?.[1];
        if (url && username && password && (pid || !options.includes("--daemon"))) {
          reported = true;
          resolveReady({ url, username, password, ...(pid ? { pid: Number(pid) } : {}) });
        } else if (output.length > 4096)
          rejectReady(new Error("Private service did not report bounded sign-in output"));
      });
      child.once("error", (error) => {
        rejectReady(error);
        rejectWaiting(error);
      });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => {
          if (!reported)
            rejectReady(new Error(`Private service exited before sign-in was available: ${redact(errors)}`));
          rejectWaiting(new Error("Private service exited without waiting"));
          resolve({ code, signal });
        });
      });
      const result = { child, ready, waiting, closed };
      children.push(result);
      return result;
    }
    try {
      const first = start();
      const second = start();
      const initial = await first.ready;
      const concurrent = await second.ready;
      expect(initial.username).toBe(userInfo().username);
      expect(concurrent.username).toBe(initial.username);
      expect(concurrent.url).toBe(initial.url);
      expect(concurrent.password === initial.password).toBe(true);
      const demoRequest = start("--demo");
      const demo = await demoRequest.ready;
      expect(new URL(demo.url).origin).toBe(initial.url);
      expect(demo.url.endsWith("/demonstration")).toBe(true);
      expect(demo.password === initial.password).toBe(true);
      expect(await demoRequest.closed).toEqual({ code: 0, signal: null });
      const completed = await Promise.race([
        first.closed.then((result) => ({ stopped: first, result })),
        second.closed.then((result) => ({ stopped: second, result })),
      ]);
      expect(completed.result).toEqual({ code: 0, signal: null });
      const running = completed.stopped === first ? second : first;
      const pid = running.child.pid;
      const stoppedPid = completed.stopped.child.pid;
      if (pid === undefined || stoppedPid === undefined) throw new Error("The fixture did not report its processes");
      expect(await privateServiceReady(distribution, pid, state, AbortSignal.timeout(5000))).toBe(true);
      expect(await privateServiceReady(distribution, stoppedPid, state, AbortSignal.timeout(5000))).toBe(false);
      const lease = readdirSync(join(state, "daemon")).find((name) => name.endsWith(".lock"));
      if (!lease) throw new Error("The running service did not publish its lease");
      expect(readFileSync(join(state, "daemon", lease, "owner.json"), "utf8").includes(initial.password)).toBe(false);

      const supervised = start("--service");
      await supervised.waiting;
      supervised.child.kill("SIGTERM");
      expect(await supervised.closed).toEqual({ code: 0, signal: null });
      const stillRunning = start();
      const existing = await stillRunning.ready;
      expect(existing.url).toBe(initial.url);
      expect(existing.password === initial.password).toBe(true);
      expect(await stillRunning.closed).toEqual({ code: 0, signal: null });

      running.child.kill("SIGKILL");
      expect(await running.closed).toEqual({ code: null, signal: "SIGKILL" });
      expect(await privateServiceReady(distribution, pid, state, AbortSignal.timeout(5000))).toBe(false);
      const restarted = start();
      const replacement = await restarted.ready;
      expect(replacement.password !== initial.password).toBe(true);
      const reused = start();
      const discovered = await reused.ready;
      expect(discovered.url).toBe(replacement.url);
      expect(discovered.password === replacement.password).toBe(true);
      expect(await reused.closed).toEqual({ code: 0, signal: null });
      const browse = (password: string) =>
        fetch(replacement.url + "/projects", {
          headers: { authorization: `Basic ${Buffer.from(`${replacement.username}:${password}`).toString("base64")}` },
        });
      const stale = await browse(initial.password);
      expect(stale.status).toBe(401);
      await stale.arrayBuffer();
      const current = await browse(replacement.password);
      expect(current.status).toBe(200);
      await current.arrayBuffer();

      restarted.child.kill("SIGTERM");
      expect(await restarted.closed).toEqual({ code: 0, signal: null });
      expect(readdirSync(join(state, "daemon"))).toEqual([]);

      const launch = start("--daemon");
      const background = await launch.ready;
      backgroundPid = background.pid;
      expect(backgroundPid).toBeGreaterThan(0);
      expect(backgroundPid).not.toBe(launch.child.pid);
      expect(await launch.closed).toEqual({ code: 0, signal: null });
      const repeat = start("--daemon");
      const runningInBackground = await repeat.ready;
      expect(runningInBackground.pid).toBe(backgroundPid);
      expect(runningInBackground.password === background.password).toBe(true);
      expect(await repeat.closed).toEqual({ code: 0, signal: null });
      const authenticated = await fetch(background.url + "/projects", {
        headers: {
          authorization: `Basic ${Buffer.from(`${background.username}:${background.password}`).toString("base64")}`,
        },
      });
      expect(authenticated.status).toBe(200);
      await authenticated.arrayBuffer();
      if (backgroundPid === undefined) throw new Error("Background service did not report its process");
      process.kill(backgroundPid, "SIGTERM");
      await expect.poll(() => readdirSync(join(state, "daemon"))).toEqual([]);
      backgroundPid = undefined;
    } finally {
      if (backgroundPid !== undefined) process.kill(backgroundPid, "SIGTERM");
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          if (await Promise.race([closed.then(() => false), delay(2000, true)])) child.kill("SIGKILL");
        }
        await closed;
      }
      const identity = createHash("sha256")
        .update(JSON.stringify([hostname(), join(state, "daemon")]))
        .digest("hex")
        .slice(0, 32);
      rmSync(join("/tmp", `wb-${String(process.getuid?.())}-${identity}`), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
