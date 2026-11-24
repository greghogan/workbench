import type { Socket } from "node:net";
import { join } from "node:path";

export const jobserverProtocol = 1;
export const jobserverClaim = /^[a-f0-9-]{36}$/;
export const jobserverProject = /^[a-f0-9]{64}$/;
export const maximumJobserverWorkers = 4096;
export const unixWorkerFifoSupported = process.platform === "linux" || process.platform === "darwin";

export function jobserverPaths(runtime: string) {
  return {
    socket: join(runtime, "jobs.sock"),
    inbox: join(runtime, "job-requests"),
    receipts: join(runtime, "job-leases"),
  };
}

export function sendJobFrame(socket: Socket, value: unknown): void {
  socket.write(JSON.stringify(value) + "\n");
}

/** Each peer sends bounded line-delimited frames over the protected local socket. */
export function readJobFrames(socket: Socket, receive: (value: unknown) => void): void {
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (part: string) => {
    input += part;
    if (input.length > 4096) {
      socket.destroy(new Error("Oversized jobserver message"));
      return;
    }
    for (let newline; (newline = input.indexOf("\n")) !== -1 && !socket.destroyed;) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      try {
        receive(JSON.parse(line) as unknown);
      } catch {
        socket.destroy(new Error("Invalid jobserver message"));
      }
    }
  });
}
