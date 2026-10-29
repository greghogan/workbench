import { decodeRecovery, type RecoveryLink } from "./recovery.js";
export class ResponseProblem extends Error {
  constructor(
    message: string,
    readonly recovery?: RecoveryLink,
    readonly transient = false,
  ) {
    super(message);
  }
}
export async function responseProblem(response: Response): Promise<ResponseProblem> {
  let message = `Request failed (HTTP ${String(response.status)})`,
    recovery: RecoveryLink | undefined;
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object") {
      if ("error" in value && typeof value.error === "string") message = value.error;
      if ("recovery" in value) recovery = decodeRecovery(value.recovery);
    }
  } catch {
    /* A non-JSON failure still retains its HTTP status. */
  }
  return new ResponseProblem(message, recovery, response.status >= 500 || response.status === 429);
}
