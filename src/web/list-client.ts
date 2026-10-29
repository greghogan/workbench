import { Notice, type BrowserSession } from "./browser-session.js";
import { recordBatchSize, recordWindowLimit } from "./record-window.js";
/** Own incremental loading and a bounded DOM window. Full links retain navigation without JavaScript. */
export function startRecordLoading(session: BrowserSession): { watch: () => void; close: () => void } {
  const { browser, document } = session;
  let observer: IntersectionObserver | undefined;
  let paused = false;
  const load = async (link: HTMLAnchorElement) => {
    const list = document.getElementById("record-list"),
      loader = document.getElementById("record-loader");
    if (!list || !loader || session.isStopped()) return;
    const existing = [...list.querySelectorAll<HTMLElement>("[data-record-id]")];
    const focused = document.activeElement;
    // Automatic loading never removes a keyboard user's focused row. Manual activation moves focus to the loader first.
    if (
      existing.length >= recordWindowLimit &&
      existing.slice(0, recordBatchSize).some((row) => row === focused || row.contains(focused))
    ) {
      paused = true;
      observer?.disconnect();
      const status = document.getElementById("record-loading-status");
      if (status)
        status.textContent = "Automatic loading paused to preserve keyboard focus. Use Load more to continue.";
      return;
    }
    if (!session.claimRead()) return;
    observer?.disconnect();
    list.setAttribute("aria-busy", "true");
    const loaderFocused = focused === link,
      label = link.textContent;
    link.textContent = "Loading…";
    try {
      const response = await browser.fetch(link.href, { headers: { Accept: "text/html" }, signal: session.signal });
      if (!response.ok) throw new Error("The record list changed or is unavailable; refresh before loading more.");
      const page = new browser.DOMParser().parseFromString(await response.text(), "text/html");
      if (session.isStopped()) return;
      const nextList = page.getElementById("record-list"),
        nextLoader = page.getElementById("record-loader");
      if (!nextList || !nextLoader || nextList.dataset.listRevision !== list.dataset.listRevision)
        throw new Error("The record list changed; refresh before loading more.");
      const rows = [...nextList.querySelectorAll<HTMLElement>("[data-record-id]")];
      const seen = new Set(existing.map((row) => row.dataset.recordId));
      if (rows.some((row) => seen.has(row.dataset.recordId)))
        throw new Error("Repeated record in the next batch; refresh the list.");
      const evicted = existing.slice(0, Math.max(0, existing.length + rows.length - recordWindowLimit));
      if (evicted.some((row) => row === document.activeElement || row.contains(document.activeElement))) {
        link.textContent = label;
        paused = true;
        return;
      }
      let first: HTMLElement | undefined;
      for (const row of rows) {
        const copy = document.importNode(row, true);
        (list.querySelector(".panel") ?? list).append(copy);
        first ??= copy;
      }
      const all = [...list.querySelectorAll<HTMLElement>("[data-record-id]")];
      const removed = all.slice(0, Math.max(0, all.length - recordWindowLimit)),
        anchor = all[removed.length];
      const top = anchor?.getBoundingClientRect().top ?? 0;
      for (const row of removed) row.remove();
      if (removed.length && anchor) browser.scrollBy(0, anchor.getBoundingClientRect().top - top);
      loader.replaceWith(document.importNode(nextLoader, true));
      const current = [...list.querySelectorAll<HTMLElement>("[data-record-id]")],
        firstId = current[0]?.dataset.recordId,
        lastId = current.at(-1)?.dataset.recordId;
      if (firstId && lastId) {
        const url = new URL(browser.location.href);
        url.searchParams.delete("before");
        url.searchParams.delete("cursor_revision");
        url.searchParams.set("through", lastId);
        const preceding = removed.at(-1)?.dataset.recordId;
        if (preceding) list.dataset.windowAfter = preceding;
        if (list.dataset.windowAfter) url.searchParams.set("after", list.dataset.windowAfter);
        else url.searchParams.delete("after");
        browser.history.replaceState(browser.history.state, "", url.href);
        const previous = document.getElementById("record-previous");
        if (previous && url.searchParams.has("after")) {
          const previousURL = new URL(url);
          for (const key of ["after", "through"]) previousURL.searchParams.delete(key);
          previousURL.searchParams.set("before", firstId);
          const back = document.createElement("a");
          back.href = previousURL.href;
          back.className = "button secondary";
          back.textContent = "Load previous records";
          previous.replaceChildren(back);
        }
      }
      const status = document.getElementById("record-loading-status");
      if (status)
        status.textContent = `Loaded ${String(rows.length)} more records. ${String(current.length)} records in the current window.`;
      if (loaderFocused) first?.focus({ preventScroll: true });
      session.clearNotice(Notice.List);
      watch();
    } catch (error) {
      if (!session.isStopped()) {
        link.textContent = label;
        session.notify(String(error), Notice.List);
      }
    } finally {
      list.removeAttribute("aria-busy");
      session.finishRead();
    }
  };
  const watch = () => {
    observer?.disconnect();
    paused = false;
    const link = document.querySelector<HTMLAnchorElement>("[data-load-more]");
    if (link && typeof browser.IntersectionObserver === "function") {
      observer = new browser.IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) void load(link);
        },
        { rootMargin: "300px" },
      );
      observer.observe(link);
    }
  };
  const clicked = (event: MouseEvent) => {
    const link =
      event.target instanceof browser.Element ? event.target.closest<HTMLAnchorElement>("[data-load-more]") : null;
    if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      link.focus({ preventScroll: true });
      void load(link);
    }
  };
  const focusChanged = () => {
    if (paused) watch();
  };
  document.addEventListener("click", clicked);
  document.addEventListener("focusin", focusChanged);
  watch();
  return {
    watch,
    close: () => {
      observer?.disconnect();
      document.removeEventListener("click", clicked);
      document.removeEventListener("focusin", focusChanged);
    },
  };
}
