#ifndef WORKBENCH_WINDOWS_COORDINATOR_H
#define WORKBENCH_WINDOWS_COORDINATOR_H

#include "windows-browser-relay.h"

struct workbench_coordinator {
    HANDLE process;
    HANDLE job;
    HANDLE commands;
    HANDLE replies;
    HANDLE stop;
    HANDLE relay;
    HANDLE watcher;
    SOCKET listener;
    BOOL network;
    struct workbench_relay_target target;
    wchar_t pipe[128];
};

void workbench_hex(const BYTE *bytes, size_t length, char *text);
DWORD workbench_coordinator_start(const wchar_t *executable, const wchar_t *entrypoint, USHORT port, HANDLE stop,
                                  struct workbench_coordinator *coordinator);
DWORD workbench_coordinator_close(struct workbench_coordinator *coordinator);
DWORD workbench_coordinator_attach(struct workbench_coordinator *coordinator, PSID account, const char *nonce,
                                   const char *key, BYTE *reply, DWORD *length);

#endif
