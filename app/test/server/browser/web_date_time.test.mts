import { expect, test } from "vitest";
import { parseDOM } from "../../fixtures/dom.mjs";
import { startLocalTimes } from "../../../src/server/browser/date-time-client.ts";
import { formatTimestamp } from "../../../src/server/presentation/date-time.ts";

test("visible timestamps use the locale and zone, omit seconds, and preserve exact wire values", () => {
  const timestamp = "2026-11-12T12:39:15.000Z";
  expect(formatTimestamp(timestamp, "en-GB", "UTC")).toBe("12 Nov 2026, 12:39 UTC");
  expect(formatTimestamp(timestamp, "de-DE", "Europe/Berlin")).toBe("12. Nov. 2026, 13:39 MEZ");
});

test("progressively inserted and replaced timestamps are localized and observation stops on cleanup", async () => {
  const dom = parseDOM(
    '<body><main><time data-local-time datetime="2026-11-12T12:39:15.000Z">Wire time</time></main></body>',
  );
  Object.defineProperty(dom.window.navigator, "languages", { value: ["en-GB"] });
  const close = startLocalTimes(dom.window as unknown as Window & typeof globalThis);
  try {
    const time = dom.window.document.querySelector("time"),
      main = dom.window.document.querySelector("main");
    if (!time || !main) throw new Error("Missing time fixture");
    expect(time.textContent).toBe(
      formatTimestamp(time.dateTime, "en-GB", new Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
    expect(time.dateTime).toBe("2026-11-12T12:39:15.000Z");
    time.outerHTML = '<time data-local-time datetime="2026-11-13T12:40:59.000Z">New wire time</time>';
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(dom.window.document.querySelector("time")?.textContent).toBe(
      formatTimestamp("2026-11-13T12:40:59.000Z", "en-GB", new Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
    close();
    main.innerHTML = '<time data-local-time datetime="2026-11-13T12:40:59.000Z">Untouched</time>';
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(dom.window.document.querySelector("time")?.textContent).toBe("Untouched");
  } finally {
    close();
    dom.window.close();
  }
});
