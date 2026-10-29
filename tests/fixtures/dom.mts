import { JSDOM, type ConstructorOptions } from "jsdom";
import { createElement, Fragment, type ComponentChildren } from "preact";
import { renderToString } from "preact-render-to-string";
import { afterEach } from "vitest";

const windows = new Set<JSDOM>();
afterEach(() => {
  for (const window of windows) window.window.close();
  windows.clear();
});
/** Test-owned DOMs always close, including when an assertion throws. */
export function parseDOM(html: string, options?: ConstructorOptions): JSDOM {
  const window = new JSDOM(html, options);
  windows.add(window);
  return window;
}
export function renderDOM(contents: ComponentChildren): Document {
  return parseDOM(renderToString(createElement(Fragment, null, contents))).window.document;
}
