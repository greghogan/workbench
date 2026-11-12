export const terminalChannels = ["stdout", "stderr"] as const;
export type TerminalChannel = (typeof terminalChannels)[number];
export const terminalLogFile = (channel: TerminalChannel): string => `${channel}.log`;
