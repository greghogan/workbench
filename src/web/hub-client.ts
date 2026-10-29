import type { CacheSize } from "../cache-size.js";
import type { Browser } from "./browser-session.js";
import { cacheQuantity } from "./cache-quantity.js";
import { decodeInventoryPatch as decodePatch, isInventorySection, type InventoryPatch } from "./inventory-protocol.js";
import { decodeCacheSize as decodeSize } from "./size-protocol.js";
/** Inventory events update measured cells and keyed rows, preserving focus and drafts. */
export function startHubUpdates(browser: Browser): () => void {
  const controller = new browser.AbortController(),
    document = browser.document;
  const events = new browser.EventSource("/events");
  const sizes = new Map<string, CacheSize>();
  let reading = false,
    queued = false,
    timer: number | undefined,
    deferred: InventoryPatch | undefined;
  const content = () => document.querySelector<HTMLElement>("[data-cache-content]");
  function remember(values: CacheSize[]) {
    for (const size of values) {
      const old = sizes.get(size.directory);
      if (old?.measuredAt && size.measuredAt && Date.parse(old.measuredAt) > Date.parse(size.measuredAt)) continue;
      sizes.set(
        size.directory,
        size.bytes === undefined && old?.bytes !== undefined
          ? { ...size, bytes: old.bytes, ...(old.measuredAt ? { measuredAt: old.measuredAt } : {}) }
          : size,
      );
    }
  }
  try {
    const initial: unknown = JSON.parse(content()?.dataset.cacheSizes ?? "[]");
    if (Array.isArray(initial)) remember(initial.map((value) => decodeSize(value)));
  } catch {
    /* Initial discovery can be empty; the event stream supplies measurements. */
  }
  function updateSizes() {
    for (const cell of document.querySelectorAll<HTMLElement>("[data-cache-members]")) {
      if (cell.dataset.cacheUncertain === "true") continue;
      const members: unknown = JSON.parse(cell.dataset.cacheMembers ?? "[]");
      if (!Array.isArray(members) || !members.every((member: unknown) => typeof member === "string")) continue;
      const value = cacheQuantity(true, sizes, members, Number(cell.dataset.cacheExtraBytes ?? 0));
      if (value.pending && cell.dataset.cachePending !== "true") continue;
      const label = cell.querySelector("a") ?? cell;
      if (label.textContent !== value.text) label.textContent = value.text;
      cell.title = value.title;
      if (value.pending) cell.dataset.cachePending = "true";
      else delete cell.dataset.cachePending;
    }
  }
  function publish(patch: InventoryPatch) {
    const current = content();
    if (!current || controller.signal.aborted) return;
    remember(patch.sizes);
    let postponed = false;
    for (const target of current.querySelectorAll<HTMLElement>("[data-cache-rows]")) {
      const section = target.dataset.cacheRows ?? "";
      if (!isInventorySection(section)) continue;
      const html = patch.sections[section];
      if (html === undefined) continue;
      const template = document.createElement("template");
      template.innerHTML = `<table><tbody>${html}</tbody></table>`;
      const rows = [...template.content.querySelectorAll<HTMLElement>("[data-cache-row]")];
      const existing = new Map(
        [...target.querySelectorAll<HTMLElement>("[data-cache-row]")].map((row) => [row.dataset.cacheRow, row]),
      );
      const ordered: HTMLElement[] = [];
      for (const row of rows) {
        const before = existing.get(row.dataset.cacheRow);
        existing.delete(row.dataset.cacheRow);
        ordered.push(before ?? row);
        if (!before) {
          target.append(row);
          continue;
        }
        const cells = new Map(
          [...before.querySelectorAll<HTMLElement>("[data-cache-cell]")].map((cell) => [cell.dataset.cacheCell, cell]),
        );
        for (const next of row.querySelectorAll<HTMLElement>("[data-cache-cell]")) {
          const cell = cells.get(next.dataset.cacheCell);
          if (!cell) continue;
          cell.title = next.title;
          for (const name of ["cacheMembers", "cacheExtraBytes", "cacheUncertain"] as const) {
            if (next.dataset[name] !== undefined) cell.dataset[name] = next.dataset[name];
            else Reflect.deleteProperty(cell.dataset, name);
          }
          if (next.innerHTML === cell.innerHTML) continue;
          if (next.dataset.cachePending === "true" && cell.dataset.cachePending !== "true") continue;
          if (cell.contains(document.activeElement)) {
            postponed = true;
            continue;
          }
          cell.innerHTML = next.innerHTML;
          if (next.dataset.cachePending) cell.dataset.cachePending = next.dataset.cachePending;
          else delete cell.dataset.cachePending;
        }
      }
      for (const row of existing.values()) {
        if (row.contains(document.activeElement)) postponed = true;
        else row.remove();
      }
      let next = target.firstElementChild;
      for (const row of ordered) {
        if (row !== next) {
          if (target.contains(document.activeElement)) {
            postponed = true;
            break;
          }
          target.insertBefore(row, next);
        }
        next = row.nextElementSibling;
      }
    }
    const problems = current.querySelector<HTMLElement>("[data-cache-problems]");
    if (problems) {
      const text = patch.problems.join("\n");
      if (problems.textContent !== text) {
        problems.replaceChildren(
          ...patch.problems.map((problem) => {
            const p = document.createElement("p");
            p.className = "notice";
            p.textContent = problem;
            return p;
          }),
        );
      }
    }
    current.dataset.cacheRefreshing = String(patch.refreshing);
    const referenced = new Set<string>();
    for (const cell of document.querySelectorAll<HTMLElement>("[data-cache-members]")) {
      const members: unknown = JSON.parse(cell.dataset.cacheMembers ?? "[]");
      if (Array.isArray(members)) for (const member of members) if (typeof member === "string") referenced.add(member);
    }
    for (const directory of sizes.keys()) if (!referenced.has(directory)) sizes.delete(directory);
    updateSizes();
    deferred = postponed ? patch : undefined;
  }
  async function refresh() {
    if (controller.signal.aborted) return;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      const url = new URL("/inventory", browser.location.href);
      url.search = browser.location.search;
      url.searchParams.delete("refresh");
      url.searchParams.delete("refresh-sizes");
      url.searchParams.set("view", browser.location.pathname === "/caches" ? "caches" : "projects");
      const response = await browser.fetch(url.href, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Inventory update failed (HTTP ${String(response.status)})`);
      publish(decodePatch(await response.json()));
    } catch {
      /* EventSource reconnect and the next inventory event retry failed reads; never discard measured sizes. */
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  }
  function schedule() {
    if (controller.signal.aborted || timer !== undefined) return;
    timer = browser.setTimeout(() => {
      timer = undefined;
      void refresh();
    }, 100);
  }
  const focusChanged = () => {
    if (deferred) publish(deferred);
  };
  const stop = () => {
    controller.abort();
    events.close();
    if (timer !== undefined) browser.clearTimeout(timer);
    document.removeEventListener("focusout", focusChanged);
  };
  events.addEventListener("inventory", schedule);
  events.addEventListener("size", (event) => {
    try {
      const value: unknown = JSON.parse((event as MessageEvent<string>).data);
      remember([decodeSize(value)]);
      updateSizes();
    } catch {
      schedule();
    }
  });
  document.addEventListener("focusout", focusChanged);
  return stop;
}
