import type { BrowserSession } from "./browser-session.js";

/** One noninteractive, hoverable preview preserves ordinary links and keyboard navigation. */
export function startReferencePreviews(session: BrowserSession): () => void {
  const { document, browser } = session;
  const popup = document.createElement("aside");
  popup.id = "record-reference-preview";
  popup.className = "reference-preview";
  popup.setAttribute("role", "tooltip");
  popup.hidden = true;
  const id = document.createElement("span"),
    title = document.createElement("strong"),
    summary = document.createElement("p");
  popup.append(id, title, summary);
  document.body.append(popup);
  let active: HTMLAnchorElement | undefined, timer: number | undefined;
  const cancel = () => {
    if (timer !== undefined) browser.clearTimeout(timer);
    timer = undefined;
  };
  const hide = () => {
    cancel();
    if (active) {
      const descriptions = (active.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((value) => value && value !== popup.id);
      if (descriptions.length) active.setAttribute("aria-describedby", descriptions.join(" "));
      else active.removeAttribute("aria-describedby");
    }
    active = undefined;
    popup.hidden = true;
  };
  const position = () => {
    if (!active?.isConnected) {
      hide();
      return;
    }
    const anchor = active.getBoundingClientRect();
    popup.style.left = `${String(Math.max(8, Math.min(anchor.left, browser.innerWidth - popup.offsetWidth - 8)))}px`;
    const below = anchor.bottom + popup.offsetHeight + 8 <= browser.innerHeight;
    popup.style.top = String(Math.max(8, below ? anchor.bottom + 8 : anchor.top - popup.offsetHeight - 8)) + "px";
  };
  const show = (link: HTMLAnchorElement) => {
    hide();
    active = link;
    id.textContent = link.dataset.recordReference ?? "";
    title.textContent = link.dataset.recordTitle ?? "";
    summary.textContent = link.dataset.recordSummary ?? "";
    summary.hidden = !summary.textContent;
    link.setAttribute("aria-describedby", [link.getAttribute("aria-describedby"), popup.id].filter(Boolean).join(" "));
    popup.hidden = false;
    position();
  };
  const anchor = (target: EventTarget | null) =>
    target instanceof browser.Element ? target.closest<HTMLAnchorElement>("a[data-record-reference]") : null;
  const over = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (popup.contains(event.target as Node)) {
      cancel();
      return;
    }
    const link = anchor(event.target);
    if (!link || link === active) return;
    cancel();
    timer = browser.setTimeout(() => {
      show(link);
    }, 180);
  };
  const out = (event: PointerEvent) => {
    if (active === document.activeElement) return;
    const next = event.relatedTarget;
    if (next instanceof browser.Node && (popup.contains(next) || active?.contains(next))) return;
    cancel();
    timer = browser.setTimeout(hide, 140);
  };
  const focus = (event: FocusEvent) => {
    const link = anchor(event.target);
    if (link) show(link);
  };
  const blur = () => {
    if (!active?.matches(":hover") && !popup.matches(":hover")) hide();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && active) {
      hide();
      event.preventDefault();
    }
  };
  const observer = new browser.MutationObserver(() => {
    if (active && !active.isConnected) hide();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerover", over);
  document.addEventListener("pointerout", out);
  document.addEventListener("focusin", focus);
  document.addEventListener("focusout", blur);
  document.addEventListener("keydown", key);
  browser.addEventListener("resize", position);
  browser.addEventListener("scroll", position, true);
  return () => {
    hide();
    observer.disconnect();
    popup.remove();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    document.removeEventListener("focusin", focus);
    document.removeEventListener("focusout", blur);
    document.removeEventListener("keydown", key);
    browser.removeEventListener("resize", position);
    browser.removeEventListener("scroll", position, true);
  };
}
