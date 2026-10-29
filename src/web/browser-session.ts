export type Browser = Window & typeof globalThis;
export const Notice = {
  Action: "action",
  List: "list",
  Draft: "draft",
  Workspace: "workspace",
  Connection: "connection",
  Refresh: "refresh",
} as const;
export type Notice = (typeof Notice)[keyof typeof Notice];
/** Coordinate DOM readers and preserve user-owned form state across asynchronous responses. */
export class BrowserSession {
  dirty = false;
  formDraft = false;
  staleReview = false;
  stopped = false;
  private reading = false;
  private queued = false;
  private readonly requests: AbortController;
  private readonly notices = new Map<Notice, string>();
  refresh: () => void = () => undefined;
  constructor(readonly browser: Browser) {
    this.requests = new browser.AbortController();
  }
  isStopped(): boolean {
    return this.stopped;
  }
  get document() {
    return this.browser.document;
  }
  get signal() {
    return this.requests.signal;
  }
  protectedView(): boolean {
    return (
      this.dirty ||
      this.formDraft ||
      Boolean(this.document.querySelector("[data-editor], [data-review], [data-proposal]"))
    );
  }
  notify(message: string, reason: Notice = Notice.Action): void {
    this.notices.set(reason, message);
    this.renderNotice();
  }
  clearNotice(reason: Notice): void {
    this.notices.delete(reason);
    this.renderNotice();
  }
  private renderNotice(): void {
    if (this.stopped) return;
    const banner = this.document.getElementById("live-status");
    if (!banner) return;
    const message = [Notice.Action, Notice.Draft, Notice.List, Notice.Workspace, Notice.Refresh, Notice.Connection]
      .map((reason) => this.notices.get(reason))
      .find((message) => message !== undefined);
    banner.hidden = message === undefined;
    const text = banner.querySelector("span");
    if (text) text.textContent = message ?? "";
    const retry = banner.querySelector<HTMLElement>("[data-workspace-retry]");
    if (retry) retry.hidden = !this.notices.has(Notice.Workspace);
    const link = banner.querySelector("a");
    if (link) {
      const url = new URL(this.browser.location.href);
      if (this.document.getElementById("record-list"))
        for (const key of ["after", "before", "through", "cursor_revision"]) url.searchParams.delete(key);
      link.href = url.href;
    }
  }
  preserveDraft(): void {
    this.staleReview = true;
    this.notify("Files changed. Refresh to inspect the latest version; your current draft is preserved.", Notice.Draft);
    for (const button of this.document.querySelectorAll<HTMLButtonElement>("[data-approve]")) button.disabled = true;
  }
  claimRead(): boolean {
    if (this.reading || this.stopped) return false;
    this.reading = true;
    return true;
  }
  queueRefresh(): void {
    this.queued = true;
  }
  finishRead(): void {
    this.reading = false;
    if (this.queued && !this.stopped) {
      this.queued = false;
      this.refresh();
    }
  }
  close(): void {
    this.stopped = true;
    this.requests.abort();
  }
}
