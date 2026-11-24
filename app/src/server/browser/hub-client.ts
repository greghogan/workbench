import { ResponseProblem, responseProblem } from "../http/response-problem.js";
import type { CacheMeasurement } from "../cache/size-protocol.js";
import type { Browser } from "./browser-session.js";
import { cacheQuantity } from "../cache/cache-quantity.js";
import {
  decodeInventoryPatch as decodePatch,
  decodeProjectCacheSize,
  isInventorySection,
  type InventoryPatch,
  type ProjectCacheSizeUpdate,
} from "../cache/inventory-protocol.js";
import { decodeCacheMeasurement as decodeSize } from "../cache/size-protocol.js";
import { startCachePreviews } from "./cache-previews.js";
import { decodeReviewCount, reviewCountLabel, type ReviewCountUpdate } from "../projects/review-count-protocol.js";
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
  const stopPreviews = startCachePreviews(browser);
  let failures = 0;
  const sizes = new Map<string, CacheMeasurement>();
  const projectSizes = new Map<string, ProjectCacheSizeUpdate>();
  let inventoryRevision = 0;
  const reviewCounts = new Map<string, ReviewCountUpdate>();
  const reviewLinks = new Map<string, Set<HTMLElement>>();
  function showReviewCount(value: ReviewCountUpdate) {
    const previous = reviewCounts.get(value.id);
    if (previous && previous.revision > value.revision) return;
    reviewCounts.set(value.id, value);
    for (const link of reviewLinks.get(value.id) ?? []) {
      link.textContent = reviewCountLabel(value);
      link.title = value.problem ?? "";
      link.dataset.reviewRevision = String(value.revision);
      if (value.count === undefined) delete link.dataset.reviewCount;
      else link.dataset.reviewCount = String(value.count);
      if (value.problem === undefined) delete link.dataset.reviewProblem;
      else link.dataset.reviewProblem = value.problem;
    }
  }
  function indexReviews() {
    reviewLinks.clear();
    for (const link of document.querySelectorAll<HTMLElement>("[data-project-reviews]")) {
      const value = decodeReviewCount({
        id: link.dataset.projectReviews,
        revision: Number(link.dataset.reviewRevision),
        ...(link.dataset.reviewCount === undefined ? {} : { count: Number(link.dataset.reviewCount) }),
        ...(link.dataset.reviewProblem === undefined ? {} : { problem: link.dataset.reviewProblem }),
      });
      const links = reviewLinks.get(value.id) ?? new Set<HTMLElement>();
      links.add(link);
      reviewLinks.set(value.id, links);
      if ((reviewCounts.get(value.id)?.revision ?? -1) < value.revision) reviewCounts.set(value.id, value);
    }
    for (const [id, value] of reviewCounts) {
      if (!reviewLinks.has(id)) reviewCounts.delete(id);
      else showReviewCount(value);
    }
  }
  const memberships = new Map<HTMLElement, string[]>();
  const cellsByDirectory = new Map<string, Set<HTMLElement>>();
  const cellsById = new Map<string, HTMLElement>();
  const changedDirectories = new Set<string>();
  let frame: number | undefined;
  function indexCells() {
    memberships.clear();
    cellsByDirectory.clear();
    cellsById.clear();
    for (const cell of document.querySelectorAll<HTMLElement>("[data-cache-cell]")) {
      if (cell.dataset.cacheCell) cellsById.set(cell.dataset.cacheCell, cell);
      if (cell.dataset.cacheMembers === undefined) continue;
      const members: unknown = JSON.parse(cell.dataset.cacheMembers);
      if (!Array.isArray(members) || !members.every((member: unknown) => typeof member === "string")) continue;
      memberships.set(cell, members);
      for (const member of members) {
        const cells = cellsByDirectory.get(member) ?? new Set<HTMLElement>();
        cells.add(cell);
        cellsByDirectory.set(member, cells);
      }
    }
  }
  function scheduleSizes() {
    if (stopped() || frame !== undefined) return;
    frame = browser.requestAnimationFrame(() => {
      frame = undefined;
      const affected = new Set<HTMLElement>();
      for (const directory of changedDirectories)
        for (const cell of cellsByDirectory.get(directory) ?? []) affected.add(cell);
      changedDirectories.clear();
      updateSizes(affected);
    });
  }
  let reading = false,
    queued = false,
    timer: number | undefined,
    deferred: InventoryPatch | undefined;
  let connection = 0,
    activeRead: AbortController | undefined;
  const content = () => document.querySelector<HTMLElement>("[data-cache-content]");
  function remember(values: CacheMeasurement[]) {
    for (const size of values) {
      const old = sizes.get(size.id);
      if (old?.measuredAt && size.measuredAt && Date.parse(old.measuredAt) > Date.parse(size.measuredAt)) continue;
      if (
        old &&
        old.bytes === size.bytes &&
        old.state === size.state &&
        old.measuredAt === size.measuredAt &&
        old.problem === size.problem
      )
        continue;
      changedDirectories.add(size.id);
      sizes.set(
        size.id,
        size.bytes === undefined && old?.bytes !== undefined
          ? { ...size, bytes: old.bytes, ...(old.measuredAt ? { measuredAt: old.measuredAt } : {}) }
          : size,
      );
    }
  }
  indexCells();
  indexReviews();
  try {
    const initial: unknown = JSON.parse(content()?.dataset.cacheSizes ?? "[]");
    if (!Array.isArray(initial)) throw new Error("Invalid initial cache measurements");
    remember(initial.map((value) => decodeSize(value)));
  } catch {
    notify(new ResponseProblem("Initial cache measurements could not be read. Refresh this page to retry."));
  }
  function updateSizes(cells: Iterable<HTMLElement> = memberships.keys()) {
    for (const cell of cells) {
      if (cell.dataset.cacheUncertain === "true") continue;
      const members = memberships.get(cell);
      if (!members) continue;
      const value = cacheQuantity(true, sizes, members, Number(cell.dataset.cacheExtraBytes ?? 0));
      if (value.pending) continue;
      const label = cell.querySelector("a") ?? cell;
      if (label.textContent !== value.text) label.textContent = value.text;
      cell.title = value.title;
      delete cell.dataset.cachePending;
    }
  }
  function showProjectSize(update: ProjectCacheSizeUpdate) {
    const preview = update.cell.replace(/-(owned|eligible|retained|tools|shared)$/, "-preview-$1");
    for (const id of [update.cell, preview]) {
      const cell = cellsById.get(id);
      if (!cell) continue;
      const label = cell.querySelector("a") ?? cell;
      if (label.textContent !== update.text) label.textContent = update.text;
      cell.title = update.title;
      delete cell.dataset.cachePending;
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
          if (
            next.dataset.cachePending === "true" &&
            next.textContent === "Calculating…" &&
            cell.textContent !== "Calculating…"
          )
            continue;
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
      const wrapper = target.closest<HTMLElement>("[data-cache-section]");
      if (wrapper) wrapper.hidden = !target.querySelector("[data-cache-row]");
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
    indexCells();
    indexReviews();
    for (const directory of sizes.keys()) if (!cellsByDirectory.has(directory)) sizes.delete(directory);
    updateSizes();
    inventoryRevision = Math.max(inventoryRevision, patch.revision ?? 0);
    for (const [cell, value] of projectSizes)
      if (value.revision <= inventoryRevision) projectSizes.delete(cell);
      else showProjectSize(value);
    deferred = postponed ? patch : undefined;
  }
  async function refresh() {
    if (stopped()) return;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    const generation = connection;
    const cancellation = new browser.AbortController();
    activeRead = cancellation;
    try {
      const inventoryUrl = content()?.dataset.inventoryUrl;
      if (!inventoryUrl)
        throw new ResponseProblem("Cache update location is unavailable. Refresh this page to reconnect.");
      const url = new URL(inventoryUrl, browser.location.href);
      const response = await browser
        .fetch(url.href, {
          signal: cancellation.signal,
          headers: { Accept: "application/json" },
        })
        .catch(() => {
          throw new ResponseProblem("Cache updates are interrupted. Refresh this page to retry.", undefined, true);
        });
      if (!response.ok) throw await responseProblem(response);
      const patch = decodePatch(await response.json());
      if (stopped() || generation !== connection) return;
      publish(patch);
      failures = 0;
      notify();
    } catch (error) {
      if (stopped() || generation !== connection) return;
      const problem =
        error instanceof ResponseProblem
          ? error
          : new ResponseProblem("Cache update response is invalid. Refresh this page to reconnect.");
      failures++;
      if (!problem.transient || failures >= 3) notify(problem);
    } finally {
      if (activeRead === cancellation) activeRead = undefined;
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
    stopPreviews();
    controller.abort();
    activeRead?.abort();
    events.close();
    if (timer !== undefined) browser.clearTimeout(timer);
    if (frame !== undefined) browser.cancelAnimationFrame(frame);
    document.removeEventListener("focusout", focusChanged);
  };
  events.addEventListener("inventory", schedule);
  events.addEventListener("open", () => {
    connection++;
    activeRead?.abort();
    deferred = undefined;
    inventoryRevision = 0;
    projectSizes.clear();
    reviewCounts.clear();
    for (const links of reviewLinks.values()) for (const link of links) link.dataset.reviewRevision = "0";
    schedule();
  });
  events.addEventListener("reviews", (event) => {
    try {
      const value = decodeReviewCount(JSON.parse((event as MessageEvent<string>).data) as unknown);
      if (reviewLinks.has(value.id)) showReviewCount(value);
    } catch {
      schedule();
    }
  });
  events.addEventListener("size", (event) => {
    try {
      const value: unknown = JSON.parse((event as MessageEvent<string>).data);
      const measurement = decodeSize(value);
      if (!cellsByDirectory.has(measurement.id)) return;
      remember([measurement]);
      scheduleSizes();
    } catch {
      schedule();
    }
  });
  events.addEventListener("project-size", (event) => {
    try {
      const value = decodeProjectCacheSize(JSON.parse((event as MessageEvent<string>).data) as unknown);
      const last = projectSizes.get(value.cell)?.revision ?? inventoryRevision;
      if (value.revision <= last) return;
      projectSizes.set(value.cell, value);
      showProjectSize(value);
    } catch {
      schedule();
    }
  });
  document.addEventListener("focusout", focusChanged);
  return stop;
}
