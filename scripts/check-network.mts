export enum CheckNetwork {
  All = "all",
  Offline = "offline",
  Online = "online",
}

export function readCheckNetwork(value: unknown): CheckNetwork {
  if (value === undefined) return CheckNetwork.All;
  for (const selection of Object.values(CheckNetwork)) if (value === selection) return selection;
  throw new Error("Unknown check network selection");
}
