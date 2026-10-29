import type { BrowserSession } from "./browser-session.js";

/** Native links retain browser navigation; disclosure buttons add a persistent, keyboard-accessible hierarchy. */
export function startSourceNavigation(session: BrowserSession): { refresh: () => void; close: () => void } {
  const { browser, document } = session;
  const key = `workbench:source-branches:${document.body.dataset.projectBase ?? ""}`;
  const saved = new Map<string, boolean>();
  let initialized = false;
  try {
    const value: unknown = JSON.parse(browser.sessionStorage.getItem(key) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [id, expanded] of Object.entries(value)) if (typeof expanded === "boolean") saved.set(id, expanded);
  } catch {
    /* Private storage is optional; navigation remains usable. */
  }
  const expand = (button: HTMLButtonElement, expanded: boolean, remember = false) => {
    button.setAttribute("aria-expanded", String(expanded));
    const children = document.getElementById(button.getAttribute("aria-controls") ?? "");
    if (children) children.hidden = !expanded;
    if (remember) {
      saved.set(button.dataset.sourceToggle ?? "", expanded);
      try {
        browser.sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(saved)));
      } catch {
        /* Storage is optional. */
      }
    }
  };
  const refresh = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-source-toggle]")) {
      button.hidden = false;
      expand(
        button,
        (!initialized && button.dataset.sourceActive === "true") ||
          (saved.get(button.dataset.sourceToggle ?? "") ??
            (button.dataset.sourceActive === "true" || button.dataset.sourceDefault === "true")),
      );
    }
    initialized = true;
  };
  const clicked = (event: MouseEvent) => {
    const button =
      event.target instanceof browser.Element ? event.target.closest<HTMLButtonElement>("[data-source-toggle]") : null;
    if (!button) return;
    const expanded = button.getAttribute("aria-expanded") !== "true";
    expand(button, expanded, true);
  };
  const keyboard = (event: KeyboardEvent) => {
    if (
      !(event.target instanceof browser.Element) ||
      !event.target.closest("[data-source-navigation]") ||
      !event.target.closest(".source-link, [data-source-toggle]") ||
      !["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    )
      return;
    const target = event.target;
    const item = target.closest("li");
    const button = item?.querySelector<HTMLButtonElement>(":scope > .source-row [data-source-toggle]");
    const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-source-navigation] .source-link")].filter(
      (link) => !link.closest("[hidden]"),
    );
    const link =
      target.closest<HTMLAnchorElement>("a") ??
      item?.querySelector<HTMLAnchorElement>(":scope > .source-row .source-link");
    let next: HTMLElement | undefined;
    if (event.key === "ArrowRight" && button) {
      if (button.getAttribute("aria-expanded") === "true")
        next = item?.querySelector<HTMLAnchorElement>(":scope > ul a") ?? undefined;
      else expand(button, true, true);
    } else if (event.key === "ArrowLeft") {
      if (button?.getAttribute("aria-expanded") === "true") expand(button, false, true);
      else
        next =
          item?.parentElement?.closest("li")?.querySelector<HTMLAnchorElement>(":scope > .source-row .source-link") ??
          item?.parentElement
            ?.closest("li")
            ?.querySelector<HTMLButtonElement>(":scope > .source-row [data-source-toggle]") ??
          undefined;
    } else if (event.key === "Home") next = links[0];
    else if (event.key === "End") next = links.at(-1);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const current = link
        ? links.indexOf(link)
        : links.findIndex(
            (candidate) => !!(target.compareDocumentPosition(candidate) & browser.Node.DOCUMENT_POSITION_FOLLOWING),
          );
      const at = current < 0 ? links.length : current;
      next = links[at + (event.key === "ArrowDown" ? (link ? 1 : 0) : -1)];
    } else return;
    event.preventDefault();
    next?.focus();
  };
  document.addEventListener("click", clicked);
  document.addEventListener("keydown", keyboard);
  refresh();
  return {
    refresh,
    close: () => {
      document.removeEventListener("click", clicked);
      document.removeEventListener("keydown", keyboard);
    },
  };
}
