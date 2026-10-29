import { decodeRecovery, type RecoveryLink } from "./recovery.js";
/** Expected interface failures retain their public meaning at the HTTP boundary. */
export class WebError extends Error {
  readonly recovery: RecoveryLink | undefined;
  constructor(
    readonly status: 400 | 403 | 404 | 406 | 409 | 413 | 500 | 503,
    message: string,
    options?: ErrorOptions & { recovery?: RecoveryLink | undefined },
  ) {
    super(message, options);
    this.name = "WebError";
    this.recovery = decodeRecovery(options?.recovery);
  }
}
