import { Notice, type BrowserSession } from "./browser-session.js";
import { recordWindowLimit } from "./record-window.js";

/** Branches load independently and keep their ancestors. Full links remain usable without script or at the DOM bound. */
export function startTaskTreeLoading(session: BrowserSession) {
  const { browser, document } = session;
  let observer: IntersectionObserver | undefined;
  const load = async (link: HTMLAnchorElement) => {
    const target = link.closest<HTMLElement>("[data-task-window]");
    if (!target || document.querySelectorAll("[data-task-node]").length >= recordWindowLimit || !session.claimRead())
      return;
    observer?.unobserve(link);
    target.setAttribute("aria-busy", "true");
    try {
      const response = await browser.fetch(link.href, { headers: { Accept: "text/html" }, signal: session.signal });
      if (!response.ok) throw new Error("Task tree changed or is unavailable; refresh before loading more.");
      const page = new browser.DOMParser().parseFromString(await response.text(), "text/html");
      if (session.isStopped()) return;
      const next = [...page.querySelectorAll<HTMLElement>("[data-task-window]")].find(
        (node) => node.dataset.taskWindow === target.dataset.taskWindow,
      );
      const items = next?.querySelector<HTMLElement>(":scope > [data-task-items]"),
        current = target.querySelector<HTMLElement>(":scope > [data-task-items]");
      if (!next || !items || !current || next.dataset.listRevision !== target.dataset.listRevision)
        throw new Error("Task tree changed; refresh before loading more.");
      const rootGroups = target.dataset.taskWindow === "roots" && !!items.querySelector(":scope > [data-task-group]");
      const rows = (container: HTMLElement) =>
        rootGroups
          ? [
              ...container.querySelectorAll<HTMLElement>(
                ":scope > [data-task-group] > [data-task-group-items] > [data-task-node]",
              ),
            ]
          : [...container.children];
      const nodes = rows(items);
      if (document.querySelectorAll("[data-task-node]").length + nodes.length > recordWindowLimit) {
        link.dataset.taskNavigate = "";
        return;
      }
      const seen = new Set(rows(current).map((node) => (node as HTMLElement).dataset.taskNode));
      if (nodes.some((node) => seen.has((node as HTMLElement).dataset.taskNode)))
        throw new Error("Repeated task in the next batch");
      const focused = document.activeElement === link;
      let first: HTMLElement | null = null;
      for (const node of nodes) {
        let destination = current;
        if (rootGroups) {
          const group = node.closest<HTMLElement>("[data-task-group]");
          if (!group) throw new Error("Missing task state group");
          let existing = [...current.querySelectorAll<HTMLElement>(":scope > [data-task-group]")].find(
            (candidate) => candidate.dataset.taskGroup === group.dataset.taskGroup,
          );
          if (!existing) {
            existing = document.importNode(group, true);
            existing.querySelector("[data-task-group-items]")?.replaceChildren();
            current.append(existing);
          }
          const list = existing.querySelector<HTMLElement>("[data-task-group-items]");
          if (!list) throw new Error("Missing task state list");
          destination = list;
        }
        const copy = document.importNode(node, true);
        destination.append(copy);
        first ??= copy.querySelector<HTMLElement>("[data-record-id]");
      }
      remember();
      const loader = next.querySelector(":scope > [data-task-loader]");
      if (loader) target.querySelector(":scope > [data-task-loader]")?.replaceWith(document.importNode(loader, true));
      if (focused) first?.focus({ preventScroll: true });
      const status = document.getElementById("task-loading-status");
      if (status) status.textContent = `Loaded ${String(nodes.length)} tasks.`;
      session.clearNotice(Notice.List);
      watch();
    } catch (error) {
      if (!session.isStopped()) session.notify(String(error), Notice.List);
    } finally {
      target.removeAttribute("aria-busy");
      session.finishRead();
    }
  };
  const remember = () => {
    const url = new URL(browser.location.href),
      windows: Record<string, string> = {};
    for (const branch of document.querySelectorAll<HTMLDetailsElement>("details[data-task-branch][open]")) {
      const window = branch.querySelector<HTMLElement>(":scope > [data-task-window]"),
        last = window?.querySelector<HTMLElement>(":scope > [data-task-items] > [data-task-node]:last-child")?.dataset
          .taskNode;
      if (branch.dataset.taskBranch) windows[branch.dataset.taskBranch] = last ?? "";
    }
    if (Object.keys(windows).length) url.searchParams.set("task_windows", JSON.stringify(windows));
    else url.searchParams.delete("task_windows");
    const window = [...document.querySelectorAll<HTMLElement>("[data-task-window]")].find(
      (node) => node.dataset.taskWindow === (url.searchParams.get("parent") ?? "roots"),
    );
    const last = [
      ...(window?.querySelectorAll<HTMLElement>(
        ":scope > [data-task-items] > [data-task-group] > [data-task-group-items] > [data-task-node], :scope > [data-task-items] > [data-task-node]",
      ) ?? []),
    ].at(-1)?.dataset.taskNode;
    if (last) url.searchParams.set("through", last);
    url.searchParams.delete("cursor_revision");
    browser.history.replaceState(browser.history.state, "", url.href);
  };
  const watch = () => {
    observer?.disconnect();
    if (document.querySelectorAll("[data-task-node]").length >= recordWindowLimit) return;
    const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-task-more]")].filter((link) => {
      const branch = link.closest<HTMLDetailsElement>("details[data-task-branch]");
      return !branch || branch.open;
    });
    if (links.length && typeof browser.IntersectionObserver === "function") {
      observer = new browser.IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.isIntersecting && entry.target instanceof browser.HTMLAnchorElement) void load(entry.target);
        },
        { rootMargin: "300px" },
      );
      for (const link of links) observer.observe(link);
    }
  };
  const toggle = (event: Event) => {
    const branch = event.target;
    if (branch instanceof browser.HTMLDetailsElement && branch.hasAttribute("data-task-branch")) {
      remember();
      if (!branch.open) {
        watch();
        return;
      }
      const link = branch.querySelector<HTMLAnchorElement>("[data-task-more]");
      if (link && !branch.querySelector("[data-task-node]")) void load(link);
      watch();
    }
  };
  const click = (event: MouseEvent) => {
    const link =
      event.target instanceof browser.Element ? event.target.closest<HTMLAnchorElement>("[data-task-more]") : null;
    if (
      !link ||
      link.hasAttribute("data-task-navigate") ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      document.querySelectorAll("[data-task-node]").length >= recordWindowLimit
    )
      return;
    event.preventDefault();
    void load(link);
  };
  document.addEventListener("toggle", toggle, true);
  document.addEventListener("click", click);
  watch();
  return {
    watch,
    close: () => {
      observer?.disconnect();
      document.removeEventListener("toggle", toggle, true);
      document.removeEventListener("click", click);
    },
  };
}
