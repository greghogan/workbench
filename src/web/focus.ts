export interface FocusLocation {
  id: string;
  href: string | null;
  record: string | undefined;
  navigation: string | null;
}
export function captureFocus(document: Document): FocusLocation | undefined {
  const element = document.activeElement;
  if (!element || element === document.body) return undefined;
  return {
    id: element.id,
    href: element.getAttribute("href"),
    record: element.closest<HTMLElement>("[data-record-id]")?.dataset.recordId,
    navigation: element.closest("nav[aria-label]")?.getAttribute("aria-label") ?? null,
  };
}
export function restoreFocus(document: Document, location: FocusLocation | undefined): void {
  if (!location) return;
  const element = location.id
    ? document.getElementById(location.id)
    : [...document.querySelectorAll<HTMLElement>(location.href === null ? "[data-record-id]" : "a[href]")].find(
        (candidate) =>
          candidate.getAttribute("href") === location.href &&
          candidate.closest<HTMLElement>("[data-record-id]")?.dataset.recordId === location.record &&
          (candidate.closest("nav[aria-label]")?.getAttribute("aria-label") ?? null) === location.navigation,
      );
  element?.focus({ preventScroll: true });
}
