import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../../runtime/values.mjs";

export const windowsJobId = /^[a-f0-9]{32}$/;
export const windowsJobSid = /^S-1-(?:\d{1,10}-){1,15}\d{1,10}$/;
export const windowsJobProject = /^[a-f0-9]{64}$/;
export const windowsJobPid = /^[1-9]\d{0,9}$/;
const execFileAsync = promisify(execFile);

export async function windowsJobControl(
  helper: string,
  args: string[],
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(helper, args, {
    cwd: dirname(helper),
    windowsHide: true,
    maxBuffer: 4096,
    timeout: 5000,
    signal,
  });
  const result: unknown = JSON.parse(stdout);
  if (!isRecord(result)) throw new Error("Invalid Windows machine jobserver response");
  return result;
}
