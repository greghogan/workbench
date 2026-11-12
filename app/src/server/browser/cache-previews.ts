import type { Browser } from "./browser-session.js";

export function cachePreviewGeometry(
  bounds: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  popup: { width: number; height: number },
) {
  const available = Math.max(0, viewport.height - 16);
  const above = Math.max(0, Math.min(available, bounds.top - 16));
  const below = Math.max(0, Math.min(available, viewport.height - bounds.bottom - 16));
  const down = popup.height <= below || below >= above;
  const maxHeight = down ? below : above;
  return {
    maxHeight,
    left: Math.max(8, Math.min(bounds.left, viewport.width - popup.width - 8)),
    top: Math.max(8, down ? bounds.bottom + 8 : bounds.top - Math.min(popup.height, maxHeight) - 8),
  };
}

/** Native popovers provide click, Escape, and outside-click behavior; hover and focus expose the same content. */
export function startCachePreviews(browser: Browser): () => void {
  const document = browser.document;
  let button: HTMLButtonElement | undefined, popup: HTMLElement | undefined, timer: number | undefined;
  let dismissed: HTMLButtonElement | undefined;
  let frame: number | undefined;
  const clear = () => {
    if (timer !== undefined) browser.clearTimeout(timer);
    timer = undefined;
  };
  const position = () => {
    if (!button?.isConnected || !popup?.matches(":popover-open")) return;
    const bounds = button.getBoundingClientRect();
    const geometry = cachePreviewGeometry(
      bounds,
      { width: browser.innerWidth, height: browser.innerHeight },
      { width: popup.offsetWidth, height: Math.max(popup.scrollHeight + 2, popup.offsetHeight) },
    );
    popup.style.maxHeight = `${String(geometry.maxHeight)}px`;
    popup.style.left = `${String(geometry.left)}px`;
    popup.style.top = `${String(geometry.top)}px`;
  };
  const schedulePosition = () => {
    if (frame !== undefined) return;
    frame = browser.requestAnimationFrame(() => {
      frame = undefined;
      position();
    });
  };
  const resize =
    typeof browser.ResizeObserver === "function" ? new browser.ResizeObserver(schedulePosition) : undefined;
  const show = (target: HTMLButtonElement) => {
    const next = document.getElementById(target.getAttribute("popovertarget") ?? "");
    if (!next || typeof next.showPopover !== "function") return;
    clear();
    dismissed = undefined;
    button = target;
    if (popup !== next) {
      resize?.disconnect();
      resize?.observe(next);
    }
    popup = next;
    if (!popup.matches(":popover-open")) popup.showPopover();
    schedulePosition();
  };
  const enter = (event: Event) => {
    if (!(event.target instanceof browser.Element)) return;
    const target = event.target.closest<HTMLButtonElement>("button[data-cache-preview]");
    if (target && target !== dismissed) show(target);
    else if (popup?.contains(event.target)) clear();
  };
  const leave = (event: Event) => {
    clear();
    const next = "relatedTarget" in event ? event.relatedTarget : undefined;
    if (dismissed && (!(next instanceof browser.Node) || (!dismissed.contains(next) && !popup?.contains(next))))
      dismissed = undefined;
    if (!popup?.matches(":popover-open")) return;
    timer = browser.setTimeout(() => {
      timer = undefined;
      if (
        button?.matches(":hover") ||
        popup?.matches(":hover") ||
        button === document.activeElement ||
        popup?.contains(document.activeElement)
      )
        return;
      if (popup?.matches(":popover-open")) popup.hidePopover();
    }, 140);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && popup?.matches(":popover-open")) {
      clear();
      dismissed = button;
    }
  };
  const toggled = (event: Event) => {
    if (event.target === popup && popup.matches(":popover-open")) {
      dismissed = undefined;
      schedulePosition();
    }
  };
  document.addEventListener("pointerover", enter);
  document.addEventListener("focusin", enter);
  document.addEventListener("pointerout", leave);
  document.addEventListener("focusout", leave);
  document.addEventListener("keydown", escape, true);
  document.addEventListener("toggle", toggled, true);
  browser.addEventListener("resize", schedulePosition);
  browser.addEventListener("scroll", schedulePosition, true);
  return () => {
    clear();
    resize?.disconnect();
    if (frame !== undefined) browser.cancelAnimationFrame(frame);
    if (popup?.matches(":popover-open")) popup.hidePopover();
    document.removeEventListener("pointerover", enter);
    document.removeEventListener("focusin", enter);
    document.removeEventListener("pointerout", leave);
    document.removeEventListener("focusout", leave);
    document.removeEventListener("keydown", escape, true);
    document.removeEventListener("toggle", toggled, true);
    browser.removeEventListener("resize", schedulePosition);
    browser.removeEventListener("scroll", schedulePosition, true);
  };
}
