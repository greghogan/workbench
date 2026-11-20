#define WIN32_LEAN_AND_MEAN
#include "windows-coordinator.h"
#include "windows-control.h"
#include "windows-private.h"
#include "windows-registration.h"
#include "windows-service-path.h"
#include "windows-worker.h"

#include <bcrypt.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

enum { maximum_workers = 32 };

struct worker_slot {
    BYTE sid[SECURITY_MAX_SID_SIZE];
    struct workbench_worker worker;
    HANDLE monitor;
    HANDLE force;
    HANDLE authority;
    ULONGLONG last_use;
    BOOL retiring;
    DWORD pid;
    char nonce[33];
    char key[65];
};

static const wchar_t *service_name, *executable, *entrypoint;
static SERVICE_STATUS_HANDLE registration;
static HANDLE stopping;
static struct worker_slot workers[maximum_workers];
static struct workbench_coordinator browser;
static USHORT browser_port;
static LONG service_checkpoint;

static BOOL service_status(DWORD stage, DWORD error) {
    SERVICE_STATUS status = {0};
    status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    status.dwCurrentState = stage;
    status.dwWin32ExitCode = error;
    if (stage == SERVICE_RUNNING)
        status.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
    if (stage == SERVICE_START_PENDING || stage == SERVICE_STOP_PENDING) {
        status.dwCheckPoint = (DWORD)InterlockedIncrement(&service_checkpoint);
        status.dwWaitHint = 15000;
    }
    return SetServiceStatus(registration, &status);
}

static DWORD WINAPI service_control(DWORD reason, DWORD event, void *data, void *context) {
    (void)event;
    (void)data;
    (void)context;
    if (reason != SERVICE_CONTROL_STOP && reason != SERVICE_CONTROL_SHUTDOWN)
        return ERROR_CALL_NOT_IMPLEMENTED;
    service_status(SERVICE_STOP_PENDING, NO_ERROR);
    return SetEvent(stopping) ? NO_ERROR : GetLastError();
}

static DWORD WINAPI monitor_worker(void *state) {
    struct worker_slot *slot = state;
    HANDLE events[] = {slot->force, slot->worker.process};
    DWORD result = WaitForMultipleObjects(2, events, FALSE, INFINITE);
    DWORD error = result == WAIT_FAILED ? GetLastError() : NO_ERROR;
    DWORD cleanup = workbench_worker_close(&slot->worker);
    return error ? error : cleanup;
}

static DWORD close_monitor(struct worker_slot *slot, DWORD timeout) {
    if (!slot->monitor)
        return NO_ERROR;
    DWORD result = WaitForSingleObject(slot->monitor, timeout);
    if (result != WAIT_OBJECT_0)
        return result == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
    DWORD error = NO_ERROR;
    if (!GetExitCodeThread(slot->monitor, &error))
        error = GetLastError();
    CloseHandle(slot->monitor);
    CloseHandle(slot->force);
    slot->monitor = NULL;
    slot->force = NULL;
    slot->retiring = FALSE;
    return error;
}

static DWORD signal_worker(struct worker_slot *slot) {
    wchar_t pipe[128];
    BYTE key[workbench_relay_key_bytes];
    for (size_t byte = 0; byte < sizeof(key); ++byte) {
        char hex[] = {slot->key[byte * 2], slot->key[byte * 2 + 1], 0};
        key[byte] = (BYTE)strtoul(hex, NULL, 16);
    }
    DWORD error = swprintf(pipe, 128, L"\\\\.\\pipe\\Workbench-Account-Stop-%hs", slot->nonce) < 0 ?
                  ERROR_INVALID_NAME : workbench_signal_pipe(pipe, slot->pid, key);
    SecureZeroMemory(key, sizeof(key));
    if (!error)
        slot->retiring = TRUE;
    return error;
}

static DWORD retire_worker(PSID sid) {
    for (size_t index = 0; index < maximum_workers; ++index) {
        struct worker_slot *slot = &workers[index];
        if (slot->authority && EqualSid(slot->sid, sid)) {
            DWORD cleanup = close_monitor(slot, 0);
            if (cleanup != ERROR_TIMEOUT || !slot->monitor)
                return cleanup;
            return slot->retiring ? NO_ERROR : signal_worker(slot);
        }
    }
    return NO_ERROR;
}

static DWORD finish_workers(BOOL browser_running) {
    DWORD error = NO_ERROR;
    for (size_t index = 0; index < maximum_workers; ++index) {
        struct worker_slot *slot = &workers[index];
        if (!slot->monitor || WaitForSingleObject(slot->monitor, 0) == WAIT_OBJECT_0)
            continue;
        if (!browser_running) {
            SetEvent(slot->force);
            continue;
        }
        DWORD signaled = slot->retiring ? NO_ERROR : signal_worker(slot);
        if (signaled && WaitForSingleObject(slot->monitor, 0) != WAIT_OBJECT_0) {
            SetEvent(slot->force);
            if (!error)
                error = signaled;
        }
    }
    for (size_t index = 0; index < maximum_workers; ++index) {
        struct worker_slot *slot = &workers[index];
        DWORD cleanup;
        while ((cleanup = close_monitor(slot, 1000)) == ERROR_TIMEOUT && slot->monitor)
            service_status(SERVICE_STOP_PENDING, NO_ERROR);
        if (!error)
            error = cleanup;
        if (slot->authority)
            CloseHandle(slot->authority);
        SecureZeroMemory(slot->key, sizeof(slot->key));
    }
    return error;
}

static DWORD workbench_worker_for(HANDLE caller, PSID sid, struct worker_slot **ready) {
    struct worker_slot *available = NULL, *idle = NULL, *same_account = NULL;
    for (size_t index = 0; index < maximum_workers; ++index) {
        struct worker_slot *slot = &workers[index];
        DWORD cleanup = close_monitor(slot, 0);
        if (cleanup && (cleanup != ERROR_TIMEOUT || !slot->monitor))
            return cleanup;
        if ((slot->monitor || slot->authority) && EqualSid(slot->sid, sid)) {
            same_account = slot;
            break;
        }
        if (!slot->monitor && !slot->authority && !available)
            available = slot;
        if (!slot->monitor && slot->authority && (!idle || slot->last_use < idle->last_use))
            idle = slot;
    }
    if (same_account) {
        available = same_account;
        if (!caller && !available->authority)
            return ERROR_NO_SUCH_LOGON_SESSION;
        available->last_use = GetTickCount64();
        if (available->retiring)
            return ERROR_BUSY;
        if (available->monitor) {
            *ready = available;
            return NO_ERROR;
        }
    } else {
        if (!caller)
            return ERROR_NO_SUCH_LOGON_SESSION;
        if (!available)
            available = idle;
        if (!available)
            return ERROR_TOO_MANY_SESS;
        if (available->authority) {
            CloseHandle(available->authority);
            available->authority = NULL;
        }
        if (!CopySid(sizeof(available->sid), available->sid, sid))
            return GetLastError();
        available->last_use = GetTickCount64();
    }
    HANDLE source = caller ? caller : available->authority;
    wchar_t nonce[33], key[65];
    DWORD error = NO_ERROR;
    if (browser_port) {
        BYTE random[48];
        if (BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
            return ERROR_GEN_FAILURE;
        workbench_hex(random, 16, available->nonce);
        workbench_hex(random + 16, 32, available->key);
        SecureZeroMemory(random, sizeof(random));
        if (swprintf(nonce, 33, L"%hs", available->nonce) < 0 ||
            swprintf(key, 65, L"%hs", available->key) < 0)
            error = ERROR_INVALID_DATA;
    }
    if (!error)
        error = workbench_worker_start(source, sid, executable, entrypoint, browser_port ? nonce : NULL,
                                       browser_port ? key : NULL, &available->worker);
    SecureZeroMemory(key, sizeof(key));
    if (!error && browser_port) {
        wchar_t pipe[128];
        if (swprintf(pipe, 128, L"\\\\.\\pipe\\Workbench-Account-%ls", nonce) < 0)
            error = ERROR_INVALID_NAME;
        else
            error = workbench_verify_pipe(pipe, available->worker.pid);
        if (!error) {
            if (swprintf(pipe, 128, L"\\\\.\\pipe\\Workbench-Account-Stop-%ls", nonce) < 0)
                error = ERROR_INVALID_NAME;
            else
                error = workbench_verify_pipe(pipe, available->worker.pid);
        }
        if (error)
            workbench_worker_close(&available->worker);
    }
    if (error)
        return error;
    if (browser_port && !available->authority &&
        !DuplicateTokenEx(source, TOKEN_DUPLICATE | TOKEN_QUERY, NULL, SecurityImpersonation, TokenImpersonation,
                          &available->authority)) {
        error = GetLastError();
        workbench_worker_close(&available->worker);
        return error;
    }
    available->pid = available->worker.pid;
    available->force = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (available->force)
        available->monitor = CreateThread(NULL, 0, monitor_worker, available, 0, NULL);
    if (!available->monitor) {
        error = GetLastError();
        if (available->force) CloseHandle(available->force);
        available->force = NULL;
        workbench_worker_close(&available->worker);
        return error;
    }
    *ready = available;
    return NO_ERROR;
}

static DWORD launch_worker(enum workbench_control_operation operation, HANDLE caller, PSID sid,
                          void *context, BYTE *reply, DWORD *length) {
    (void)context;
    if (operation == workbench_retire_account) {
        DWORD error = retire_worker(sid);
        const char retired[] = "{\"retired\":true}";
        if (error)
            return error;
        if (*length < sizeof(retired) - 1)
            return ERROR_INSUFFICIENT_BUFFER;
        *length = sizeof(retired) - 1;
        memcpy(reply, retired, *length);
        return NO_ERROR;
    }
    struct worker_slot *worker = NULL;
    DWORD error = workbench_worker_for(caller, sid, &worker);
    if (error)
        return error;
    if (browser_port && caller)
        return workbench_coordinator_attach(&browser, sid, worker->nonce, worker->key, reply, length);
    int count = browser_port ?
                snprintf((char *)reply, *length, "{\"nonce\":\"%s\",\"key\":\"%s\",\"pid\":%lu}",
                         worker->nonce, worker->key, (unsigned long)worker->pid) :
                snprintf((char *)reply, *length, "{\"pid\":%lu}", (unsigned long)worker->pid);
    if (count < 0 || (DWORD)count >= *length)
        return ERROR_INVALID_DATA;
    *length = (DWORD)count;
    return NO_ERROR;
}

static DWORD configured_payload(void) {
    wchar_t image[32768];
    DWORD size = GetModuleFileNameW(NULL, image, sizeof(image) / sizeof(image[0]));
    if (!size || size >= sizeof(image) / sizeof(image[0]))
        return ERROR_INVALID_NAME;
    DWORD error = workbench_service_file(image);
    if (!error)
        error = workbench_service_file(executable);
    return error ? error : workbench_service_file(entrypoint);
}

static void WINAPI run_service(DWORD count, wchar_t **arguments) {
    (void)count;
    (void)arguments;
    registration = RegisterServiceCtrlHandlerExW(service_name, service_control, NULL);
    if (!registration || !service_status(SERVICE_START_PENDING, NO_ERROR))
        return;
    DWORD error = configured_payload();
    if (!error && browser_port) {
        WSADATA network;
        error = WSAStartup(MAKEWORD(2, 2), &network);
        if (!error) {
            error = workbench_registration(L"inspect", service_name, executable, entrypoint, browser_port);
            WSACleanup();
        }
    }
    if (!error) {
        stopping = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!stopping)
            error = GetLastError();
    }
    BOOL browser_running = FALSE;
    BOOL reported_running = FALSE;
    if (!error && browser_port) {
        /* SCM may stop the service during handoff. The control pipe separately reports readiness. */
        if (!service_status(SERVICE_RUNNING, NO_ERROR))
            error = GetLastError();
        else {
            reported_running = TRUE;
            error = workbench_wait_for_private_listeners(stopping);
            if (!error) {
                error = workbench_coordinator_start(executable, entrypoint, browser_port, stopping, &browser);
                browser_running = !error;
            }
        }
    }
    HANDLE listener = INVALID_HANDLE_VALUE;
    if (!error)
        error = workbench_control_listen(service_name, &listener);
    if (!error) {
        if (reported_running || service_status(SERVICE_RUNNING, NO_ERROR))
            error = workbench_control_serve(listener, stopping, launch_worker, NULL, NULL);
        else
            error = GetLastError();
    }
    if (error == ERROR_OPERATION_ABORTED && stopping && WaitForSingleObject(stopping, 0) == WAIT_OBJECT_0)
        error = NO_ERROR;
    if (listener != INVALID_HANDLE_VALUE)
        CloseHandle(listener);
    if (stopping) {
        service_status(SERVICE_STOP_PENDING, NO_ERROR);
        SetEvent(stopping);
        if (browser_running) {
            DWORD cleanup = workbench_coordinator_close(&browser);
            if (!error)
                error = cleanup;
        }
        DWORD cleanup = finish_workers(browser_running);
        if (!error)
            error = cleanup;
        CloseHandle(stopping);
    }
    service_status(SERVICE_STOPPED, error);
}

static DWORD describe_service(const wchar_t *name) {
    SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
    if (!manager)
        return GetLastError();
    SC_HANDLE service = OpenServiceW(manager, name, SERVICE_QUERY_STATUS);
    DWORD error = NO_ERROR;
    const char *state = "unregistered";
    DWORD pid = 0;
    if (!service) {
        error = GetLastError();
        if (error == ERROR_SERVICE_DOES_NOT_EXIST)
            error = NO_ERROR;
    } else {
        SERVICE_STATUS_PROCESS observed;
        DWORD required;
        if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&observed, sizeof(observed), &required)) {
            error = GetLastError();
        } else if (!(observed.dwServiceType & SERVICE_WIN32_OWN_PROCESS)) {
            error = ERROR_INVALID_OWNER;
        } else {
            pid = observed.dwProcessId;
            switch (observed.dwCurrentState) {
                case SERVICE_RUNNING: {
                    BOOL ready = FALSE;
                    error = workbench_control_ready(name, pid, &ready);
                    state = ready ? "running" : "starting";
                    break;
                }
                case SERVICE_START_PENDING: state = "starting"; break;
                case SERVICE_STOP_PENDING: state = "stopping"; break;
                case SERVICE_STOPPED: state = "stopped"; break;
                default: error = ERROR_INVALID_STATE; break;
            }
        }
        CloseServiceHandle(service);
    }
    CloseServiceHandle(manager);
    if (!error && printf("{\"state\":\"%s\",\"pid\":%lu}\n", state, (unsigned long)pid) < 0)
        error = ERROR_WRITE_FAULT;
    return error;
}

int wmain(int count, wchar_t **arguments) {
    DWORD error = ERROR_INVALID_PARAMETER;
    USHORT port = 0;
    if (count == 6) {
        wchar_t *end = NULL;
        unsigned long selected_port = wcstoul(arguments[5], &end, 10);
        if (!selected_port || selected_port > 65535 || *end)
            return ERROR_INVALID_PARAMETER;
        port = (USHORT)selected_port;
    }
    if ((count == 5 || count == 6) && !wcscmp(arguments[1], L"service")) {
        service_name = arguments[2];
        executable = arguments[3];
        entrypoint = arguments[4];
        browser_port = port;
        SERVICE_TABLE_ENTRYW table[] = {{(wchar_t *)service_name, run_service}, {NULL, NULL}};
        error = StartServiceCtrlDispatcherW(table) ? NO_ERROR : GetLastError();
    } else if (count == 6 &&
               (!wcscmp(arguments[1], L"register") || !wcscmp(arguments[1], L"unregister") ||
                !wcscmp(arguments[1], L"inspect") || !wcscmp(arguments[1], L"start") || !wcscmp(arguments[1], L"stop"))) {
        WSADATA network;
        error = WSAStartup(MAKEWORD(2, 2), &network);
        if (!error) {
            error = workbench_registration(arguments[1], arguments[2], arguments[3], arguments[4], port);
            WSACleanup();
        }
    } else if ((count == 3 && !wcscmp(arguments[1], L"launch")) ||
               (count == 4 && (!wcscmp(arguments[1], L"resume") || !wcscmp(arguments[1], L"retire")))) {
        BYTE output[workbench_control_capacity];
        DWORD length = 0;
        PSID sid = NULL;
        if (count == 4 && !ConvertStringSidToSidW(arguments[3], &sid))
            error = GetLastError();
        else {
            enum workbench_control_operation operation = workbench_sign_in;
            if (sid)
                operation = !wcscmp(arguments[1], L"resume") ? workbench_resume_account : workbench_retire_account;
            error = workbench_control_request(arguments[2], operation, sid, output, &length);
        }
        if (sid)
            LocalFree(sid);
        if (!error && (fwrite(output, 1, length, stdout) != length || fputc('\n', stdout) == EOF))
            error = ERROR_WRITE_FAULT;
        SecureZeroMemory(output, sizeof(output));
    } else if ((count == 3 && !wcscmp(arguments[1], L"private-read")) ||
               (count == 4 && (!wcscmp(arguments[1], L"private-listen") || !wcscmp(arguments[1], L"private-drain")))) {
        error = workbench_private_control(arguments[1], arguments[2], count == 4 ? arguments[3] : NULL);
    } else if (count == 5 && !wcscmp(arguments[1], L"private-launch")) {
        error = workbench_private_launch(arguments[2], arguments[3], arguments[4]);
    } else if (count == 3 && !wcscmp(arguments[1], L"status")) {
        error = describe_service(arguments[2]);
    } else if (count == 3 && !wcscmp(arguments[1], L"verify-path")) {
        error = workbench_service_file(arguments[2]);
    }
    if (error)
        fprintf(stderr, "Workbench SCM operation failed (%lu)\n", (unsigned long)error);
    return (int)error;
}
