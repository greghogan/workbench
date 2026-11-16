import type { BrowserSession } from "./browser-session.js";

/** Filter the file tree and follow the visible or hovered comparison. */
export function startCommitFiles(session: BrowserSession) {
  const { browser, document } = session;
  const navigation = document.querySelector<HTMLElement>(".commit-navigation"),
    tree = navigation?.querySelector<HTMLElement>(".commit-navigation-list"),
    pane = document.querySelector<HTMLElement>(".commit-content");
  const sections = [...(pane?.querySelectorAll<HTMLElement>("[data-commit-file]") ?? [])],
    links = new Map(
      [...(tree?.querySelectorAll<HTMLAnchorElement>("[data-commit-file-path] > a") ?? [])].map((link) => [
        link.parentElement?.dataset.commitFilePath,
        link,
      ]),
    );
  const selected = navigation?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
  const linkFor = (section: HTMLElement | null | undefined) => links.get(section?.dataset.commitFile);
  let current = selected,
    hovered: HTMLAnchorElement | undefined,
    frame = 0;
  const reveal = (link: HTMLAnchorElement) => {
    if (!tree || !link.getClientRects().length) return;
    const viewport = tree.getBoundingClientRect(),
      row = link.getBoundingClientRect();
    if (row.top < viewport.top) tree.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) tree.scrollTop += row.bottom - viewport.bottom;
  };
  const targetSection = (hash: string): HTMLElement | undefined => {
    if (!hash.startsWith("#commit-file-")) return undefined;
    const target = document.getElementById(hash.slice(1));
    return target && pane?.contains(target) && target.hasAttribute("data-commit-file") ? target : undefined;
  };
  const update = () => {
    frame = 0;
    if (!navigation || !pane || selected) return;
    const navigationBounds = navigation.getBoundingClientRect(),
      stacked = navigationBounds.right > pane.getBoundingClientRect().left,
      top = stacked ? Math.max(0, navigationBounds.bottom) : 0;
    let low = 0,
      high = sections.length;
    // File sections stay in document order, including collapsed or deferred comparisons.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((sections[middle]?.getBoundingClientRect().bottom ?? 0) > top) high = middle;
      else low = middle + 1;
    }
    const target = targetSection(browser.location.hash),
      bounds = target?.getBoundingClientRect(),
      section = bounds && bounds.bottom > top && bounds.top < browser.innerHeight ? target : sections[low],
      next = section && section.getBoundingClientRect().top < browser.innerHeight ? linkFor(section) : undefined;
    if (next === current) return;
    current?.removeAttribute("aria-current");
    current = next;
    if (current) {
      current.setAttribute("aria-current", "location");
      reveal(current);
    }
  };
  const schedule = () => {
    if (!frame && sections.length && !selected) frame = browser.requestAnimationFrame(update);
  };
  const hover = (next?: HTMLAnchorElement) => {
    if (next === hovered) return;
    hovered?.removeAttribute("data-file-hover");
    hovered = next;
    if (hovered) {
      hovered.setAttribute("data-file-hover", "");
      reveal(hovered);
    }
  };
  const point = (event: PointerEvent) => {
    hover(
      event.target instanceof browser.Element
        ? linkFor(event.target.closest<HTMLElement>("[data-commit-file]"))
        : undefined,
    );
  };
  const leave = () => {
    hover();
  };
  const jump = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target instanceof browser.Element ? event.target.closest("a[href^='#']") : null;
    const target = targetSection(link?.getAttribute("href") ?? "");
    if (target instanceof browser.HTMLDetailsElement) target.open = true;
  };
  const resize =
    pane && typeof browser.ResizeObserver === "function" ? new browser.ResizeObserver(schedule) : undefined;
  if (pane) resize?.observe(pane);
  if (navigation) resize?.observe(navigation);
  if (sections.length) {
    browser.addEventListener("scroll", schedule, { passive: true });
    browser.addEventListener("resize", schedule);
    browser.addEventListener("hashchange", schedule);
    navigation?.addEventListener("click", jump);
    pane?.addEventListener("pointerover", point);
    pane?.addEventListener("pointerleave", leave);
  }
  const expanded = new Map<HTMLDetailsElement, boolean>();
  const filter = () => {
    const input = document.querySelector<HTMLInputElement>("[data-commit-file-filter]");
    const search = input?.value.toLocaleLowerCase() ?? "";
    for (const row of document.querySelectorAll<HTMLElement>("[data-commit-file-path]"))
      row.hidden = !(row.dataset.commitFilePath ?? "").toLocaleLowerCase().includes(search);
    for (const directory of document.querySelectorAll<HTMLElement>("[data-commit-directory]")) {
      directory.hidden = ![...directory.querySelectorAll<HTMLElement>("[data-commit-file-path]")].some(
        (row) => !row.hidden,
      );
      const details = directory.querySelector("details");
      if (!details) continue;
      if (search) {
        if (!expanded.has(details)) expanded.set(details, details.open);
        details.open = true;
      } else if (expanded.has(details)) {
        details.open = expanded.get(details) ?? true;
        expanded.delete(details);
      }
    }
  };
  const watch = () => {
    const label = document.querySelector<HTMLElement>("[data-commit-filter]");
    if (label) label.hidden = false;
    filter();
    if (selected) reveal(selected);
    schedule();
  };
  document.addEventListener("input", filter);
  watch();
  return {
    watch,
    close: () => {
      document.removeEventListener("input", filter);
      browser.removeEventListener("scroll", schedule);
      browser.removeEventListener("resize", schedule);
      browser.removeEventListener("hashchange", schedule);
      navigation?.removeEventListener("click", jump);
      pane?.removeEventListener("pointerover", point);
      pane?.removeEventListener("pointerleave", leave);
      resize?.disconnect();
      if (frame) browser.cancelAnimationFrame(frame);
      leave();
      expanded.clear();
    },
  };
}
