import { Notice, type BrowserSession } from "./browser-session.js";

/** Load and expand immutable file comparisons without replacing neighboring files or navigation. */
export function startFileDifferences(session: BrowserSession) {
  const { browser, document } = session;
  const pending = new Set<HTMLElement>();
  const fetchPage = async (href: string) => {
    const response = await browser.fetch(href, { headers: { Accept: "text/html" }, signal: session.signal });
    if (!response.ok) throw new Error("File diff is unavailable; retry the link.");
    return new browser.DOMParser().parseFromString(await response.text(), "text/html");
  };
  const replace = (current: HTMLElement, replacement: HTMLElement, focus: boolean) => {
    const copy = document.importNode(replacement, true);
    current.replaceWith(copy);
    if (focus) {
      const target = copy.querySelector<HTMLElement>(".file-diff-scroll") ?? copy;
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    return copy;
  };
  const load = async (link: HTMLAnchorElement) => {
    const current = link.closest<HTMLElement>("[data-file-diff]");
    if (!current || pending.has(current) || session.isStopped()) return;
    pending.add(current);
    const height = current.getBoundingClientRect().height,
      above = link.getAttribute("aria-label") === "Show more lines above";
    current.setAttribute("aria-busy", "true");
    try {
      const page = await fetchPage(link.href),
        replacement = [...page.querySelectorAll<HTMLElement>("[data-file-diff]")].find(
          (node) =>
            node.dataset.filePath === current.dataset.filePath &&
            node.dataset.fileCommit === current.dataset.fileCommit,
        );
      if (session.isStopped() || !current.isConnected) return;
      if (!replacement) throw new Error("The file comparison changed; refresh before continuing.");
      const copy = replace(current, replacement, true);
      if (above) browser.scrollBy(0, copy.getBoundingClientRect().height - height);
      if (new URL(browser.location.href).searchParams.get("path") === current.dataset.filePath) {
        browser.history.replaceState(browser.history.state, "", link.href);
        for (const choice of document.querySelectorAll<HTMLAnchorElement>('[aria-label="Difference layout"] a')) {
          const destination = new URL(link.href);
          const layout = new URL(choice.href).searchParams.get("layout");
          if (layout) destination.searchParams.set("layout", layout);
          choice.href = destination.href;
        }
      }
      session.clearNotice(Notice.List);
    } catch (error) {
      if (!session.isStopped()) session.notify(error instanceof Error ? error.message : String(error), Notice.List);
    } finally {
      current.removeAttribute("aria-busy");
      pending.delete(current);
    }
  };
  const clicked = (event: MouseEvent) => {
    const link =
      event.target instanceof browser.Element
        ? event.target.closest<HTMLAnchorElement>("a[data-file-diff-link]")
        : null;
    if (
      !link ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      session.isStopped()
    )
      return;
    event.preventDefault();
    void load(link);
  };
  let loading = false;
  const active = (list: HTMLElement) => list.isConnected && !session.isStopped();
  const loadBatches = async (list: HTMLElement) => {
    const placeholders = new Map<string, HTMLElement>();
    for (const link of list.querySelectorAll("[data-file-diff-auto]")) {
      const file = link.closest<HTMLElement>("[data-file-diff]");
      if (file?.dataset.filePath) placeholders.set(file.dataset.filePath, file);
    }
    loading = true;
    try {
      while (list.dataset.fileDiffBatch && active(list)) {
        const page = await fetchPage(list.dataset.fileDiffBatch);
        if (!active(list)) return;
        const batch = page.querySelector<HTMLElement>("[data-file-diff-result]");
        if (!batch || batch.dataset.fileDiffResult !== list.dataset.commit)
          throw new Error("The file comparison changed; refresh before continuing.");
        for (const replacement of batch.querySelectorAll<HTMLElement>("[data-file-diff]")) {
          const current = placeholders.get(replacement.dataset.filePath ?? "");
          if (replacement.dataset.fileCommit === list.dataset.commit && current?.isConnected && !pending.has(current))
            replace(current, replacement, current.contains(document.activeElement));
        }
        if (batch.dataset.fileDiffBatch) list.dataset.fileDiffBatch = batch.dataset.fileDiffBatch;
        else delete list.dataset.fileDiffBatch;
      }
    } catch (error) {
      if (active(list)) {
        delete list.dataset.fileDiffBatch;
        session.notify(error instanceof Error ? error.message : String(error), Notice.List);
      }
    } finally {
      loading = false;
      watch();
    }
  };
  const watch = () => {
    if (loading || session.isStopped()) return;
    const list = document.getElementById("commit-file-list");
    if (list?.dataset.fileDiffBatch) void loadBatches(list);
  };
  document.addEventListener("click", clicked);
  watch();
  return {
    watch,
    close: () => {
      document.removeEventListener("click", clicked);
    },
  };
}
