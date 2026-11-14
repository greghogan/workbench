import { formatTimestamp, isTimestamp } from "../presentation/date-time.js";
import type { Browser } from "./browser-session.js";

export function startLocalTimes(browser: Browser): () => void {
  const update = (root: ParentNode) => {
    for (const element of root.querySelectorAll<HTMLTimeElement>("time[data-local-time]")) {
      if (isTimestamp(element.dateTime))
        element.textContent = formatTimestamp(
          element.dateTime,
          browser.navigator.languages,
          new Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
    }
  };
  update(browser.document);
  const observer = new browser.MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof browser.Element) {
          const timestamp = node.getAttribute("datetime");
          if (node.matches("time[data-local-time]") && isTimestamp(timestamp))
            node.textContent = formatTimestamp(
              timestamp,
              browser.navigator.languages,
              new Intl.DateTimeFormat().resolvedOptions().timeZone,
            );
          update(node);
        }
  });
  observer.observe(browser.document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
  };
}
