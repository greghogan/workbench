import type { RecoveryLink } from "./recovery.js";
export type Browser = Window & typeof globalThis;
export const Notice = {
  Action: "action",
  List: "list",
  Draft: "draft",
  Review: "review",
  Workspace: "workspace",
  Connection: "connection",
  Refresh: "refresh",
} as const;
export type Notice = (typeof Notice)[keyof typeof Notice];
/** Coordinate DOM readers and preserve user-owned form state across asynchronous responses. */
export class BrowserSession {
  readonly pendingActions = new Set<HTMLFormElement>();
  dirty = false;
  formDraft = false;
  staleDraft = false;
  readonly protection: "page" | "editor" | "review" | "proposal" | "resolution";
  stopped = false;
  private reading = false;
  private queued = false;
  private readonly requests: AbortController;
  private readonly notices = new Map<Notice, { message: string; recovery?: RecoveryLink }>();
  refresh: () => void = () => undefined;
  constructor(readonly browser: Browser) {
    this.requests = new browser.AbortController();
    this.protection = this.document.querySelector("[data-resolution]")
      ? "resolution"
      : this.document.querySelector("[data-review]")
        ? "review"
        : this.document.querySelector("[data-editor]")
          ? "editor"
          : this.document.querySelector("[data-proposal]")
            ? "proposal"
            : "page";
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
    return this.dirty || this.formDraft || this.pendingActions.size > 0 || this.protection !== "page";
  }
  notify(message: string, reason: Notice = Notice.Action, recovery?: RecoveryLink): void {
    this.notices.set(reason, { message, ...(recovery ? { recovery } : {}) });
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
    const message = [
      Notice.Action,
      Notice.Review,
      Notice.Draft,
      Notice.List,
      Notice.Workspace,
      Notice.Refresh,
      Notice.Connection,
    ]
      .map((reason) => this.notices.get(reason))
      .find((message) => message !== undefined);
    banner.hidden = message === undefined;
    const text = banner.querySelector("span");
    if (text) text.textContent = message?.message ?? "";
    const retry = banner.querySelector<HTMLElement>("[data-workspace-retry]");
    if (retry) retry.hidden = !this.notices.has(Notice.Workspace);
    const link = banner.querySelector("a");
    if (link) {
      const url = new URL(this.browser.location.href);
      if (this.document.getElementById("record-list"))
        for (const key of ["after", "before", "through", "cursor_revision"]) url.searchParams.delete(key);
      if (this.document.querySelector("[data-task-window]"))
        for (const key of ["after", "before", "through", "cursor_revision", "task_windows", "parent"])
          url.searchParams.delete(key);
      link.href = message?.recovery?.href ?? url.href;
      link.textContent = message?.recovery?.label ?? "Refresh";
    }
  }
  preserveDraft(): void {
    this.staleDraft = true;
    this.notify("Files changed. Refresh to inspect the latest version; your current draft is preserved.", Notice.Draft);
    for (const button of this.document.querySelectorAll<HTMLButtonElement>("[data-approve]")) button.disabled = true;
  }
  reviewChanged(changed: readonly HTMLFormElement[]): void {
    const stale = new Set(changed);
    for (const form of this.document.querySelectorAll<HTMLFormElement>("form[data-review]")) {
      const refresh = form.querySelector<HTMLAnchorElement>("[data-review-refresh]");
      if (!refresh) continue;
      refresh.hidden = !stale.has(form);
      if (refresh.hidden && this.document.activeElement === refresh)
        form.querySelector<HTMLButtonElement>("[data-approve]")?.focus({ preventScroll: true });
    }
    if (changed.length) {
      if (!this.notices.has(Notice.Review))
        this.notify("File changed on disk. Refresh to view the latest version.", Notice.Review);
    } else this.clearNotice(Notice.Review);
  }
  resolutionChanged(changed: boolean): void {
    if (changed) {
      this.notify("Compatibility finding changed or was reviewed. Refresh to view current findings.", Notice.Review);
      for (const button of this.document.querySelectorAll<HTMLButtonElement>("[data-resolution] [data-approve]"))
        button.disabled = true;
    } else this.clearNotice(Notice.Review);
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
