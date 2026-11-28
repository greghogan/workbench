#define WIN32_LEAN_AND_MEAN
#include "windows-browser-relay.h"

#include <iphlpapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static DWORD WINAPI wait_for_stop(void *context) {
    HANDLE stop = context;
    while (WaitForSingleObject(stop, 50) == WAIT_TIMEOUT) {
        DWORD available = 0;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), NULL, 0, NULL, &available, NULL) || available) {
            SetEvent(stop);
            break;
        }
    }
    return NO_ERROR;
}

static DWORD prove_relay(const wchar_t *pipe, DWORD controller, USHORT port) {
    struct workbench_relay_target target = {0};
    target.pipe = pipe;
    target.process = controller;
    DWORD length = 0;
    while (length < sizeof(target.key)) {
        DWORD received = 0;
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), target.key + length,
                      sizeof(target.key) - length, &received, NULL))
            return GetLastError();
        if (!received)
            return ERROR_BROKEN_PIPE;
        length += received;
    }
    HANDLE stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!stop)
        return GetLastError();
    HANDLE watcher = CreateThread(NULL, 0, wait_for_stop, stop, 0, NULL);
    DWORD result = watcher ? NO_ERROR : GetLastError();
    SOCKET listener = INVALID_SOCKET;
    if (!result)
        result = workbench_browser_listener(port, &listener);
    if (!result) {
        puts("ready");
        fflush(stdout);
        result = workbench_browser_relay(listener, stop, &target);
    }
    if (watcher) {
        SetEvent(stop);
        WaitForSingleObject(watcher, INFINITE);
        CloseHandle(watcher);
    }
    SecureZeroMemory(target.key, sizeof(target.key));
    CloseHandle(stop);
    return result;
}

int wmain(int argc, wchar_t **argv) {
    if (argc != 3 && argc != 5)
        return ERROR_INVALID_PARAMETER;
    wchar_t *end = NULL;
    unsigned long requested = wcstoul(argv[2], &end, 10);
    if (!requested || requested > 65535 || *end)
        return ERROR_INVALID_PARAMETER;
    USHORT port = (USHORT)requested;
    WSADATA network;
    DWORD result = WSAStartup(MAKEWORD(2, 2), &network);
    if (!result) {
        result = ERROR_INVALID_PARAMETER;
        if (argc == 3 && !wcscmp(argv[1], L"reserve")) {
            ULONG64 token = 0;
            result = CreatePersistentTcpPortReservation(htons(port), 1, &token);
        } else if (argc == 3 && !wcscmp(argv[1], L"release")) {
            result = DeletePersistentTcpPortReservation(htons(port), 1);
        } else if (argc == 5 && !wcscmp(argv[1], L"relay")) {
            DWORD process = wcstoul(argv[4], &end, 10);
            if (process && !*end)
                result = prove_relay(argv[3], process, port);
        }
        WSACleanup();
    }
    if (result)
        fprintf(stderr, "Windows browser relay fixture failed (%lu)\n", (unsigned long)result);
    return (int)result;
}
