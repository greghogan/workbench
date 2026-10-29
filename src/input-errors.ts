/** Invalid caller-owned declarations or paths; distinct from implementation faults. */
export class InvalidInput extends Error {}

/** An authoritative object no longer exists. */
export class MissingResource extends Error {}
/** Caller input was valid for an earlier state and must be reviewed again. */
export class StateConflict extends Error {}
