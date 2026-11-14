import { InvalidInput } from "../runtime/input-errors.js";
export interface PushUpdate {
  localRef: string;
  tip: string;
  remoteRef: string;
  previous: string;
}
export const zeroRevision = (value: string): boolean => /^0+$/.test(value);
export function pushUpdates(input: string): PushUpdate[] {
  return input
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(/\s+/),
        [localRef, tip, remoteRef, previous] = fields;
      if (
        fields.length !== 4 ||
        !localRef ||
        !remoteRef ||
        !tip ||
        !previous ||
        ![tip, previous].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) ||
        tip.length !== previous.length
      )
        throw new InvalidInput("Invalid pre-push ref update");
      return { localRef, tip, remoteRef, previous };
    });
}
