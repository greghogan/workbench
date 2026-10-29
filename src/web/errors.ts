/** Expected interface failures retain their public meaning at the HTTP boundary. */
export class WebError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 500 | 503,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebError";
  }
}
