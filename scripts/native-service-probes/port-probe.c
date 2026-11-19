#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <mstcpip.h>
#include <stdio.h>
#include <wchar.h>

static HANDLE stop_event;
static SERVICE_STATUS_HANDLE status_handle;
static wchar_t *service_name;
static USHORT port;

static int failure(const char *operation, DWORD status) {
    fprintf(stderr, "%s failed (%lu)\n", operation, (unsigned long)status);
    return (int)status;
}

static struct sockaddr_in endpoint(void) {
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = port;
    return addr;
}

enum bind_target { LOOPBACK, WILDCARD, DUAL_STACK };

static int bind_port(SOCKET socket_handle, enum bind_target target) {
    const BOOL exclusive = TRUE;
    if (setsockopt(socket_handle, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                   (const char *)&exclusive, sizeof(exclusive)) == SOCKET_ERROR)
        return failure("setsockopt", WSAGetLastError());
    if (target == DUAL_STACK) {
        const DWORD only_ipv6 = 0;
        struct sockaddr_in6 addr = {0};
        addr.sin6_family = AF_INET6;
        addr.sin6_port = port;
        if (setsockopt(socket_handle, IPPROTO_IPV6, IPV6_V6ONLY,
                       (const char *)&only_ipv6, sizeof(only_ipv6)) == SOCKET_ERROR)
            return failure("IPv6 dual-stack option", WSAGetLastError());
        if (bind(socket_handle, (const struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR)
            return failure("dual-stack bind", WSAGetLastError());
    } else {
        struct sockaddr_in addr = endpoint();
        if (target == WILDCARD)
            addr.sin_addr.s_addr = htonl(INADDR_ANY);
        if (bind(socket_handle, (const struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR)
            return failure("IPv4 bind", WSAGetLastError());
    }
    return 0;
}

static int associate(SOCKET socket_handle) {
    INET_PORT_RESERVATION_TOKEN token = {0};
    DWORD bytes = 0;
    DWORD error = LookupPersistentTcpPortReservation(port, 1, &token.Token);
    if (error != NO_ERROR)
        return failure("lookup", error);
    if (WSAIoctl(socket_handle, SIO_ASSOCIATE_PORT_RESERVATION,
                 &token, sizeof(token), NULL, 0, &bytes, NULL, NULL) == SOCKET_ERROR)
        return failure("associate", WSAGetLastError());
    return 0;
}

static BOOL service_status(DWORD state, DWORD error) {
    SERVICE_STATUS status = {0};
    status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    status.dwCurrentState = state;
    status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP : 0;
    status.dwWin32ExitCode = error;
    if (state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING) {
        status.dwWaitHint = 10000;
        status.dwCheckPoint = 1;
    }
    return SetServiceStatus(status_handle, &status);
}

static DWORD WINAPI control(DWORD code, DWORD event, void *data, void *context) {
    (void)event;
    (void)data;
    (void)context;
    if (code != SERVICE_CONTROL_STOP)
        return ERROR_CALL_NOT_IMPLEMENTED;
    service_status(SERVICE_STOP_PENDING, NO_ERROR);
    return SetEvent(stop_event) ? NO_ERROR : GetLastError();
}

static void WINAPI service_main(DWORD count, wchar_t **arguments) {
    (void)count;
    (void)arguments;
    status_handle = RegisterServiceCtrlHandlerExW(service_name, control, NULL);
    if (!status_handle)
        return;
    if (!service_status(SERVICE_START_PENDING, NO_ERROR))
        return;
    stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!stop_event) {
        service_status(SERVICE_STOPPED, GetLastError());
        return;
    }
    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int result = listener == INVALID_SOCKET ? WSAGetLastError() : associate(listener);
    if (!result)
        result = bind_port(listener, LOOPBACK);
    if (!result && listen(listener, SOMAXCONN) == SOCKET_ERROR)
        result = WSAGetLastError();
    if (!result && !service_status(SERVICE_RUNNING, NO_ERROR))
        result = GetLastError();
    if (!result && WaitForSingleObject(stop_event, INFINITE) == WAIT_FAILED)
        result = GetLastError();
    if (listener != INVALID_SOCKET)
        closesocket(listener);
    CloseHandle(stop_event);
    service_status(SERVICE_STOPPED, (DWORD)result);
}

static int execute(int argc, wchar_t **argv) {
    if (!wcscmp(argv[1], L"reserve")) {
        ULONG64 token = 0;
        DWORD result = CreatePersistentTcpPortReservation(port, 1, &token);
        return result ? failure("reserve", result) : 0;
    }
    if (!wcscmp(argv[1], L"release")) {
        DWORD result = DeletePersistentTcpPortReservation(port, 1);
        return result ? failure("release", result) : 0;
    }
    if (!wcscmp(argv[1], L"service") && argc == 4) {
        service_name = argv[3];
        SERVICE_TABLE_ENTRYW table[] = {{service_name, service_main}, {NULL, NULL}};
        return StartServiceCtrlDispatcherW(table) ? 0 : failure("service dispatcher", GetLastError());
    }
    const int dual_stack = !wcscmp(argv[1], L"bind-dual-stack");
    SOCKET probe = socket(dual_stack ? AF_INET6 : AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (probe == INVALID_SOCKET)
        return failure("socket", WSAGetLastError());
    int result = ERROR_INVALID_PARAMETER;
    if (!wcscmp(argv[1], L"bind")) {
        result = bind_port(probe, LOOPBACK);
    } else if (!wcscmp(argv[1], L"bind-wildcard")) {
        result = bind_port(probe, WILDCARD);
    } else if (dual_stack) {
        result = bind_port(probe, DUAL_STACK);
    } else if (!wcscmp(argv[1], L"bind-with-reservation")) {
        result = associate(probe);
        if (!result)
            result = bind_port(probe, LOOPBACK);
    } else if (!wcscmp(argv[1], L"connect")) {
        struct sockaddr_in addr = endpoint();
        result = connect(probe, (const struct sockaddr *)&addr, sizeof(addr)) != SOCKET_ERROR
            ? 0 : failure("connect", WSAGetLastError());
    }
    closesocket(probe);
    return result;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 3 || argc > 4)
        return ERROR_INVALID_PARAMETER;
    wchar_t *end = NULL;
    unsigned long n = wcstoul(argv[2], &end, 10);
    if (!n || n > 65535 || *end)
        return ERROR_INVALID_PARAMETER;
    port = htons((USHORT)n);
    WSADATA data;
    int result = WSAStartup(MAKEWORD(2, 2), &data);
    if (result)
        return failure("WSAStartup", (DWORD)result);
    result = execute(argc, argv);
    WSACleanup();
    return result;
}
