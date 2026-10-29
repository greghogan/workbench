import { ResponseProblem, responseProblem } from "./response-problem.js";
import type { CacheSize } from "../cache-size.js";
import type { Browser } from "./browser-session.js";
import { cacheQuantity } from "./cache-quantity.js";
import { decodeInventoryPatch as decodePatch, isInventorySection, type InventoryPatch } from "./inventory-protocol.js";
import { decodeCacheSize as decodeSize } from "./size-protocol.js";
/** Inventory events update measured cells and keyed rows, preserving focus and drafts. */
export function startHubUpdates(browser: Browser): () => void {
  const controller = new browser.AbortController(),
    document = browser.document;
  const stopped = () => controller.signal.aborted;
  const notify = (problem?: ResponseProblem) => {
    const status = document.getElementById("inventory-status");
    if (!status) return;
    status.hidden = !problem;
    const text = status.querySelector("span"),
      link = status.querySelector("a");
    if (text) text.textContent = problem?.message ?? "";
    if (link) {
      link.href = problem?.recovery?.href ?? browser.location.href;
      link.textContent = problem?.recovery?.label ?? "Refresh";
    }
  };
  const eventsUrl = document.body.dataset.eventsUrl;
  if (!eventsUrl) {
    notify(new ResponseProblem("Cache updates are unavailable. Refresh this page to reconnect."));
    return () => undefined;
  }
  const events = new browser.EventSource(eventsUrl);
  let failures = 0;
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
    if (!Array.isArray(initial)) throw new Error("Invalid initial cache measurements");
    remember(initial.map((value) => decodeSize(value)));
  } catch {
    notify(new ResponseProblem("Initial cache measurements could not be read. Refresh this page to retry."));
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
    if (!current || stopped()) return;
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
          const disclosure = cell.querySelector<HTMLDetailsElement>("details[data-worktree-list]"),
            nextDisclosure = next.querySelector<HTMLDetailsElement>("details[data-worktree-list]");
          if (disclosure && nextDisclosure) nextDisclosure.open = disclosure.open;
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
    if (stopped()) return;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      const inventoryUrl = content()?.dataset.inventoryUrl;
      if (!inventoryUrl)
        throw new ResponseProblem("Cache update location is unavailable. Refresh this page to reconnect.");
      const url = new URL(inventoryUrl, browser.location.href);
      const response = await browser
        .fetch(url.href, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        })
        .catch(() => {
          throw new ResponseProblem("Cache updates are interrupted. Refresh this page to retry.", undefined, true);
        });
      if (!response.ok) throw await responseProblem(response);
      publish(decodePatch(await response.json()));
      failures = 0;
      notify();
    } catch (error) {
      if (stopped()) return;
      const problem =
        error instanceof ResponseProblem
          ? error
          : new ResponseProblem("Cache update response is invalid. Refresh this page to reconnect.");
      failures++;
      if (!problem.transient || failures >= 3) notify(problem);
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  }
  function schedule() {
    if (stopped() || timer !== undefined) return;
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
