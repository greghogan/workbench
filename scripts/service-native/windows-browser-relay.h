#ifndef WORKBENCH_WINDOWS_BROWSER_RELAY_H
#define WORKBENCH_WINDOWS_BROWSER_RELAY_H

#include <winsock2.h>
#include <windows.h>

enum { workbench_relay_key_bytes = 32 };

struct workbench_relay_target {
    const wchar_t *pipe;
    DWORD process;
    BYTE key[workbench_relay_key_bytes];
};

/* Uses a pre-provisioned port reservation and binds only IPv4 loopback. */
DWORD workbench_browser_listener(USHORT port, SOCKET *listener);

/* A native launcher accepts readiness only from the process it owns. */
DWORD workbench_verify_pipe(const wchar_t *pipe, DWORD process);
DWORD workbench_signal_pipe(const wchar_t *pipe, DWORD process, BYTE key[workbench_relay_key_bytes]);

/* Relays native browser connections to a PID-verified controller pipe. Owns listener until return. */
DWORD workbench_browser_relay(SOCKET listener, HANDLE stop_event, const struct workbench_relay_target *target);

#endif
