import { ResponseProblem, responseProblem } from "./response-problem.js";
import { decodeCompatibilityVersions, decodeReviewVersions } from "./review-status.js";
import { Notice, type BrowserSession } from "./browser-session.js";
import { captureFocus, restoreFocus } from "./focus.js";
import { workspaceProblemText } from "./workspace-problem.js";

/** Own live connection and refresh publication; check draft ownership again after every asynchronous read. */
export function startLiveUpdates(session: BrowserSession, afterPublish: () => void): () => void {
  const { browser, document } = session;
  const eventsUrl = document.body.dataset.eventsUrl;
  if (!eventsUrl) {
    session.notify("Live updates are unavailable. Refresh this page to reconnect.", Notice.Connection);
    return () => undefined;
  }
  const events = new browser.EventSource(eventsUrl);
  let problem = document.body.dataset.workspaceProblem ?? "";
  if (problem) session.notify(workspaceProblemText(problem), Notice.Workspace);
  let revision = document.body.dataset.revision ?? "";
  const refresh = async () => {
    const reviews = [...document.querySelectorAll<HTMLFormElement>("form[data-review]")];
    const resolutions = [...document.querySelectorAll<HTMLFormElement>("form[data-resolution]")];
    if (session.protectedView() && !reviews.length && !resolutions.length) {
      session.preserveDraft();
      return;
    }
    if (!session.claimRead()) {
      session.queueRefresh();
      return;
    }
    const expected = revision;
    try {
      const url = new URL(browser.location.href);
      if (document.querySelector("[data-task-window]")) url.searchParams.delete("cursor_revision");
      const last = [...document.querySelectorAll<HTMLElement>("#record-list [data-record-id]")].at(-1)?.dataset
        .recordId;
      if (last) {
        url.searchParams.delete("before");
        const after = document.getElementById("record-list")?.dataset.windowAfter;
        if (after) url.searchParams.set("after", after);
        else url.searchParams.delete("after");
        url.searchParams.set("through", last);
        url.searchParams.delete("cursor_revision");
      }
      if (resolutions.length) {
        const statusUrl = document.body.dataset.compatibilityStatusUrl;
        if (!statusUrl) throw new Error("Compatibility status location is unavailable");
        const response = await browser.fetch(statusUrl, {
          headers: { Accept: "application/json" },
          signal: session.signal,
        });
        if (!response.ok) throw await responseProblem(response);
        const current = decodeCompatibilityVersions(await response.json());
        if (session.isStopped()) return;
        if (expected !== revision) {
          session.queueRefresh();
          return;
        }
        session.resolutionChanged(
          resolutions.some(
            (form) =>
              form.querySelector<HTMLInputElement>('input[name="policy_digest"]')?.value !== current.policy_digest ||
              !current.findings.has(form.querySelector<HTMLInputElement>('input[name="finding"]')?.value ?? ""),
          ),
        );
        session.clearNotice(Notice.Refresh);
        return;
      }
      if (reviews.length) {
        const statusUrl = document.body.dataset.reviewStatusUrl;
        if (!statusUrl) throw new Error("Review status location is unavailable");
        const response = await browser.fetch(statusUrl, {
          headers: { Accept: "application/json" },
          signal: session.signal,
        });
        if (!response.ok) throw await responseProblem(response);
        const versions = decodeReviewVersions(await response.json());
        if (session.isStopped()) return;
        if (expected !== revision) {
          session.queueRefresh();
          return;
        }
        session.reviewChanged(
          reviews.filter(
            (form) =>
              versions.get(form.querySelector<HTMLInputElement>('input[name="path"]')?.value ?? "") !==
              form.querySelector<HTMLInputElement>('input[name="digest"]')?.value,
          ),
        );
        session.clearNotice(Notice.Refresh);
        return;
      }
      const response = await browser.fetch(url.href, { headers: { Accept: "text/html" }, signal: session.signal });
      if (!response.ok) throw await responseProblem(response);
      const page = new browser.DOMParser().parseFromString(await response.text(), "text/html");
      if (session.isStopped()) return;
      if (expected !== revision) {
        session.queueRefresh();
        return;
      }
      if (session.protectedView()) {
        session.preserveDraft();
        return;
      }
      const next = page.querySelector("main"),
        current = document.querySelector("main");
      const focused = captureFocus(document);
      const top = browser.scrollY;
      if (next && current) {
        current.replaceWith(document.importNode(next, true));
        for (const selector of [
          'nav[aria-label="Main navigation"]',
          "[data-source-navigation]",
          ".topbar .project-switch",
          ".topbar .project-context",
        ]) {
          const replacement = page.querySelector(selector);
          if (replacement) document.querySelector(selector)?.replaceWith(document.importNode(replacement, true));
        }
        document.title = page.title;
        for (const key of ["revision", "reviewStatusUrl", "compatibilityStatusUrl", "workspaceProblem"] as const) {
          const value = page.body.dataset[key];
          if (value === undefined) Reflect.deleteProperty(document.body.dataset, key);
          else document.body.dataset[key] = value;
        }
        afterPublish();
        restoreFocus(document, focused);
        browser.scrollTo(0, top);
      }
      session.clearNotice(Notice.Refresh);
    } catch (error) {
      if (!session.isStopped())
        session.notify(
          `Live refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          Notice.Refresh,
          error instanceof ResponseProblem ? error.recovery : undefined,
        );
    } finally {
      session.finishRead();
    }
  };
  session.refresh = () => {
    void refresh();
  };
  const changed = (event: MessageEvent<string>) => {
    if (event.data === revision) return;
    revision = event.data;
    session.refresh();
  };
  const freshness = (event: MessageEvent<string>) => {
    try {
      const value: unknown = JSON.parse(event.data);
      if (
        !value ||
        typeof value !== "object" ||
        !("refreshing" in value) ||
        typeof value.refreshing !== "boolean" ||
        !("problem" in value) ||
        typeof value.problem !== "string"
      )
        return;
      const message = value.problem ? workspaceProblemText(value.problem) : "";
      if (value.problem && value.problem !== problem) session.notify(message, Notice.Workspace);
      else if (!value.problem && problem) session.clearNotice(Notice.Workspace);
      problem = value.problem;
    } catch {
      /* Ignore malformed advisory events; the last complete page remains usable. */
    }
  };
  events.addEventListener("revision", changed);
  events.addEventListener("freshness", freshness);
  events.addEventListener("open", () => {
    session.clearNotice(Notice.Connection);
  });
  events.onerror = () => {
    session.notify("Live connection interrupted. Reconnecting; you can also refresh this page.", Notice.Connection);
  };
  return () => {
    events.close();
  };
}
