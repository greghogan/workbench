#define WIN32_LEAN_AND_MEAN
#include "windows-browser-relay.h"

#include <iphlpapi.h>
#include <mstcpip.h>
#include <string.h>
#include <wchar.h>

enum { connection_limit = 64, buffer_bytes = 16384, pipe_wait = 1000 };

DWORD workbench_browser_listener(USHORT port, SOCKET *listener) {
    *listener = INVALID_SOCKET;
    if (!port)
        return ERROR_INVALID_PARAMETER;
    INET_PORT_RESERVATION_TOKEN reservation = {0};
    USHORT network_port = htons(port);
    DWORD error = LookupPersistentTcpPortReservation(network_port, 1, &reservation.Token);
    if (error)
        return error;
    SOCKET native = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0,
                               WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
    if (native == INVALID_SOCKET)
        return WSAGetLastError();
    const BOOL exclusive = TRUE;
    DWORD written = 0;
    struct sockaddr_in origin = {0};
    origin.sin_family = AF_INET;
    origin.sin_port = network_port;
    origin.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (setsockopt(native, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive, sizeof(exclusive)) == SOCKET_ERROR ||
        WSAIoctl(native, SIO_ASSOCIATE_PORT_RESERVATION, &reservation, sizeof(reservation),
                 NULL, 0, &written, NULL, NULL) == SOCKET_ERROR ||
        bind(native, (const struct sockaddr *)&origin, sizeof(origin)) == SOCKET_ERROR ||
        listen(native, SOMAXCONN) == SOCKET_ERROR) {
        error = WSAGetLastError();
        closesocket(native);
        return error;
    }
    *listener = native;
    return NO_ERROR;
}

static HANDLE open_controller(const struct workbench_relay_target *target) {
    HANDLE pipe = CreateFileW(target->pipe, FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                              0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT |
                              SECURITY_IDENTIFICATION, NULL);
    if (pipe == INVALID_HANDLE_VALUE)
        return pipe;
    ULONG peer = 0;
    if (!GetNamedPipeServerProcessId(pipe, &peer) || peer != target->process) {
        CloseHandle(pipe);
        SetLastError(ERROR_INVALID_OWNER);
        return INVALID_HANDLE_VALUE;
    }
    return pipe;
}

DWORD workbench_verify_pipe(const wchar_t *name, DWORD process) {
    struct workbench_relay_target target = {0};
    target.pipe = name;
    target.process = process;
    ULONGLONG deadline = GetTickCount64() + 15000;
    for (;;) {
        HANDLE pipe = open_controller(&target);
        if (pipe != INVALID_HANDLE_VALUE) {
            CloseHandle(pipe);
            return NO_ERROR;
        }
        DWORD error = GetLastError();
        if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PIPE_BUSY)
            return error;
        if (GetTickCount64() >= deadline)
            return ERROR_TIMEOUT;
        Sleep(30);
    }
}

static DWORD signal_io(HANDLE pipe, BYTE *data, DWORD length, BOOL sending) {
    OVERLAPPED io = {0};
    io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    DWORD error = NO_ERROR, written = 0;
    if (!io.hEvent) {
        error = GetLastError();
    } else {
        BOOL transferred = sending ? WriteFile(pipe, data, length, &written, &io) :
                           ReadFile(pipe, data, length, &written, &io);
        if (!transferred) {
            error = GetLastError();
            if (error == ERROR_IO_PENDING) {
                DWORD ready = WaitForSingleObject(io.hEvent, 5000);
                if (ready == WAIT_OBJECT_0) {
                    error = GetOverlappedResult(pipe, &io, &written, FALSE) ? NO_ERROR : GetLastError();
                } else {
                    error = ready == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
                    CancelIoEx(pipe, &io);
                    GetOverlappedResult(pipe, &io, &written, TRUE);
                }
            }
        }
        CloseHandle(io.hEvent);
    }
    return error ? error : written == length ? NO_ERROR : ERROR_WRITE_FAULT;
}

DWORD workbench_signal_pipe(const wchar_t *name, DWORD process, BYTE key[workbench_relay_key_bytes]) {
    struct workbench_relay_target target = {0};
    target.pipe = name;
    target.process = process;
    HANDLE pipe = open_controller(&target);
    if (pipe == INVALID_HANDLE_VALUE)
        return GetLastError();
    DWORD error = signal_io(pipe, key, workbench_relay_key_bytes, TRUE);
    BYTE accepted = 0;
    if (!error)
        error = signal_io(pipe, &accepted, 1, FALSE);
    CloseHandle(pipe);
    return error ? error : accepted == 1 ? NO_ERROR : ERROR_INVALID_DATA;
}

struct direction {
    OVERLAPPED io;
    BOOL active;
    DWORD size;
    DWORD sent;
    BYTE data[buffer_bytes];
};

static void sent_bytes(struct direction *flow, DWORD sent) {
    flow->sent += sent;
    if (flow->sent == flow->size)
        flow->sent = flow->size = 0;
}

/* ERROR_IO_PENDING and ERROR_IO_INCOMPLETE leave the existing operation in flight. */
static DWORD pipe_io(HANDLE pipe, struct direction *flow, BOOL writing, BOOL *progress) {
    DWORD bytes = 0;
    BOOL complete;
    if (flow->active) {
        complete = GetOverlappedResult(pipe, &flow->io, &bytes, FALSE);
        if (!complete && GetLastError() == ERROR_IO_INCOMPLETE)
            return NO_ERROR;
    } else {
        ResetEvent(flow->io.hEvent);
        complete = writing ?
            WriteFile(pipe, flow->data + flow->sent, flow->size - flow->sent, &bytes, &flow->io) :
            ReadFile(pipe, flow->data, sizeof(flow->data), &bytes, &flow->io);
        if (!complete && GetLastError() == ERROR_IO_PENDING) {
            flow->active = TRUE;
            return NO_ERROR;
        }
    }
    flow->active = FALSE;
    if (!complete)
        return GetLastError();
    if (!bytes)
        return ERROR_BROKEN_PIPE;
    if (writing)
        sent_bytes(flow, bytes);
    else
        flow->size = bytes;
    *progress = TRUE;
    return NO_ERROR;
}

static void retire_io(HANDLE pipe, struct direction *flow) {
    if (flow->active) {
        DWORD transferred = 0;
        CancelIoEx(pipe, &flow->io);
        GetOverlappedResult(pipe, &flow->io, &transferred, TRUE);
    }
    if (flow->io.hEvent)
        CloseHandle(flow->io.hEvent);
    SecureZeroMemory(flow->data, sizeof(flow->data));
}

static DWORD from_browser(SOCKET browser, struct direction *flow, BOOL *input_closed, BOOL *progress) {
    int bytes = recv(browser, (char *)flow->data, sizeof(flow->data), 0);
    if (bytes == SOCKET_ERROR) {
        DWORD error = WSAGetLastError();
        return error == WSAEWOULDBLOCK ? NO_ERROR : error;
    }
    if (bytes)
        flow->size = (DWORD)bytes;
    else
        *input_closed = TRUE;
    *progress = TRUE;
    return NO_ERROR;
}

static DWORD to_browser(SOCKET browser, struct direction *flow, BOOL *progress) {
    int bytes = send(browser, (const char *)flow->data + flow->sent, (int)(flow->size - flow->sent), 0);
    if (bytes == SOCKET_ERROR) {
        DWORD error = WSAGetLastError();
        return error == WSAEWOULDBLOCK ? NO_ERROR : error;
    }
    if (!bytes)
        return ERROR_BROKEN_PIPE;
    sent_bytes(flow, (DWORD)bytes);
    *progress = TRUE;
    return NO_ERROR;
}

struct connection {
    SOCKET browser;
    HANDLE stop;
    const struct workbench_relay_target *target;
    HANDLE lifetime;
};

static void exchange_bytes(struct connection *peer, HANDLE pipe, HANDLE net, struct direction *input,
                            struct direction *output) {
    BOOL input_closed = FALSE;
    while (WaitForSingleObject(peer->stop, 0) == WAIT_TIMEOUT) {
        BOOL progress = FALSE;
        if (!output->size && pipe_io(pipe, output, FALSE, &progress))
            break;
        if (output->size && to_browser(peer->browser, output, &progress))
            break;
        if (!input->size && !input_closed && from_browser(peer->browser, input, &input_closed, &progress))
            break;
        if (input->size && pipe_io(pipe, input, TRUE, &progress))
            break;
        if (progress)
            continue;
        HANDLE events[] = {peer->stop, net, NULL, NULL};
        DWORD length = 2;
        if (output->active)
            events[length++] = output->io.hEvent;
        if (input->active)
            events[length++] = input->io.hEvent;
        DWORD ready = WaitForMultipleObjects(length, events, FALSE, INFINITE);
        if (ready < WAIT_OBJECT_0 + 1 || ready >= WAIT_OBJECT_0 + length)
            break;
        if (ready == WAIT_OBJECT_0 + 1) {
            WSANETWORKEVENTS activity;
            if (WSAEnumNetworkEvents(peer->browser, net, &activity) == SOCKET_ERROR ||
                ((activity.lNetworkEvents & FD_CLOSE) && activity.iErrorCode[FD_CLOSE_BIT]))
                break;
        }
    }
}

static DWORD WINAPI relay_connection(void *context) {
    struct connection *peer = context;
    WSAEVENT activity = WSACreateEvent();
    HANDLE controller = INVALID_HANDLE_VALUE;
    struct direction input = {0}, output = {0};
    if (activity != WSA_INVALID_EVENT &&
        !WSAEventSelect(peer->browser, activity, FD_READ | FD_WRITE | FD_CLOSE)) {
        if (WaitNamedPipeW(peer->target->pipe, pipe_wait))
            controller = open_controller(peer->target);
        if (controller != INVALID_HANDLE_VALUE) {
            input.io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
            output.io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
            if (input.io.hEvent && output.io.hEvent) {
                memcpy(input.data, peer->target->key, sizeof(peer->target->key));
                input.size = sizeof(peer->target->key);
                exchange_bytes(peer, controller, activity, &input, &output);
            }
            retire_io(controller, &input);
            retire_io(controller, &output);
            CloseHandle(controller);
        }
    }
    closesocket(peer->browser);
    if (activity != WSA_INVALID_EVENT)
        WSACloseEvent(activity);
    return NO_ERROR;
}

static struct connection *next_connection(struct connection connections[connection_limit]) {
    for (size_t index = 0; index < connection_limit; ++index) {
        struct connection *peer = &connections[index];
        if (peer->lifetime && WaitForSingleObject(peer->lifetime, 0) == WAIT_OBJECT_0) {
            CloseHandle(peer->lifetime);
            peer->lifetime = NULL;
        }
        if (!peer->lifetime)
            return peer;
    }
    return NULL;
}

static DWORD accept_connections(SOCKET listener, HANDLE stop_event, WSAEVENT activity, HANDLE cancel,
                                const struct workbench_relay_target *target,
                                struct connection connections[connection_limit]) {
    HANDLE events[] = {stop_event, activity};
    for (;;) {
        DWORD ready = WaitForMultipleObjects(2, events, FALSE, INFINITE);
        if (ready == WAIT_OBJECT_0)
            return NO_ERROR;
        if (ready != WAIT_OBJECT_0 + 1)
            return ready == WAIT_FAILED ? GetLastError() : ERROR_INVALID_HANDLE;
        WSANETWORKEVENTS network;
        if (WSAEnumNetworkEvents(listener, activity, &network) == SOCKET_ERROR)
            return WSAGetLastError();
        if (network.lNetworkEvents & FD_CLOSE)
            return ERROR_CONNECTION_ABORTED;
        while (WaitForSingleObject(stop_event, 0) == WAIT_TIMEOUT) {
            SOCKET browser = accept(listener, NULL, NULL);
            if (browser == INVALID_SOCKET) {
                DWORD error = WSAGetLastError();
                if (error != WSAEWOULDBLOCK)
                    return error;
                break;
            }
            struct connection *peer = next_connection(connections);
            if (peer) {
                *peer = (struct connection){browser, cancel, target, NULL};
                peer->lifetime = CreateThread(NULL, 0, relay_connection, peer, 0, NULL);
            }
            if (!peer || !peer->lifetime)
                closesocket(browser);
        }
    }
}

DWORD workbench_browser_relay(SOCKET listener, HANDLE stop_event, const struct workbench_relay_target *target) {
    static const wchar_t prefix[] = L"\\\\.\\pipe\\Workbench-Browser-";
    static const wchar_t hex[] = L"0123456789abcdef";
    const size_t prefix_length = sizeof(prefix) / sizeof(prefix[0]) - 1;
    DWORD error = NO_ERROR;
    if (!target->process || wcsncmp(target->pipe, prefix, prefix_length) ||
        wcslen(target->pipe + prefix_length) != 32 || wcsspn(target->pipe + prefix_length, hex) != 32)
        error = ERROR_INVALID_NAME;
    HANDLE cancel = NULL;
    WSAEVENT activity = WSA_INVALID_EVENT;
    if (!error) {
        cancel = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!cancel)
            error = GetLastError();
    }
    if (!error) {
        activity = WSACreateEvent();
        if (activity == WSA_INVALID_EVENT || WSAEventSelect(listener, activity, FD_ACCEPT | FD_CLOSE))
            error = WSAGetLastError();
    }
    struct connection connections[connection_limit] = {0};
    if (!error)
        error = accept_connections(listener, stop_event, activity, cancel, target, connections);
    closesocket(listener);
    if (activity != WSA_INVALID_EVENT)
        WSACloseEvent(activity);
    if (cancel) {
        SetEvent(cancel);
        for (size_t index = 0; index < connection_limit; ++index) {
            if (connections[index].lifetime) {
                WaitForSingleObject(connections[index].lifetime, INFINITE);
                CloseHandle(connections[index].lifetime);
            }
        }
        CloseHandle(cancel);
    }
    return error;
}
