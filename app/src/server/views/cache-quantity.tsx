import type { Quantity } from "../cache/cache-quantity.js";
import { cacheSizeKey } from "../cache/cache-view-model.js";
export const quantityValue = (id: string, value: Quantity, href?: string, measure = true) => (
  <span
    data-cache-cell={id}
    data-cache-members={measure ? JSON.stringify(value.directories.map(cacheSizeKey)) : undefined}
    data-cache-extra-bytes={measure ? String(value.extra) : undefined}
    data-cache-uncertain={value.uncertain ? "true" : undefined}
    data-cache-pending={value.pending ? "true" : undefined}
    title={value.title}
  >
    {href ? <a href={href}>{value.text}</a> : value.text}
  </span>
);
export const cell = (id: string, value: Quantity, href?: string, measure = true) => (
  <td>{quantityValue(id, value, href, measure)}</td>
);
