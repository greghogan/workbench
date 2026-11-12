import type { BrowserSession } from "./browser-session.js";

/** Keep ordinary title links and selectable text while making a card's background navigable. */
export function startCardNavigation(session: BrowserSession): () => void {
  const { browser, document } = session;
  const clicked = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof browser.Element) ||
      event.target.closest("a, button, input, select, textarea, label, summary, [contenteditable]") ||
      browser.getSelection()?.isCollapsed === false
    )
      return;
    event.target.closest("[data-card]")?.querySelector<HTMLAnchorElement>("a[data-card-link]")?.click();
  };
  document.addEventListener("click", clicked);
  return () => {
    document.removeEventListener("click", clicked);
  };
}
