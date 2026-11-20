#define WIN32_LEAN_AND_MEAN
#include "windows-coordinator.h"

#include "windows-control.h"
#include "windows-worker.h"
#include <bcrypt.h>
#include <sddl.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

enum { command_limit = 2048, launch_wait = 20000, stop_wait = 5000 };

void workbench_hex(const BYTE *bytes, size_t length, char *text) {
    static const char hex[] = "0123456789abcdef";
    for (size_t index = 0; index < length; ++index) {
        text[index * 2] = hex[bytes[index] >> 4];
        text[index * 2 + 1] = hex[bytes[index] & 15];
    }
    text[length * 2] = 0;
}

static DWORD coordinator_environment(wchar_t (*block)[32768]) {
    static const wchar_t *const isolated[] = {
        L"ALLUSERSPROFILE", L"APPDATA", L"COMSPEC", L"LOCALAPPDATA", L"PATH", L"PROGRAMDATA",
        L"SYSTEMDRIVE", L"SYSTEMROOT", L"TEMP", L"TMP", L"USERPROFILE", L"WINDIR",
        L"WORKBENCH_CONFIG_HOME", L"WORKBENCH_LOG_FILE_LEVEL", L"WORKBENCH_LOG_FORMAT", L"WORKBENCH_LOG_LEVEL",
    };
    size_t length = 0;
    for (size_t index = 0; index < sizeof(isolated) / sizeof(isolated[0]); ++index) {
        const wchar_t *name = isolated[index];
        size_t names = wcslen(name);
        if (length + names + 2 >= 32768)
            return ERROR_ENVVAR_NOT_FOUND;
        DWORD size = GetEnvironmentVariableW(name, *block + length + names + 1, (DWORD)(32768 - length - names - 1));
        if (!size)
            continue;
        if (size >= 32768 - length - names - 1)
            return ERROR_ENVVAR_NOT_FOUND;
        wmemcpy(*block + length, name, names);
        (*block)[length + names] = L'=';
        length += names + size + 2;
    }
    static const wchar_t authority[] =
        L"WORKBENCH_WINDOWS_SCM=1\0WORKBENCH_WINDOWS_WORKER_IDLE=1\0WORKBENCH_WINDOWS_WORKER_RESUME=1\0";
    if (length + sizeof(authority) / sizeof(authority[0]) > 32768)
        return ERROR_ENVVAR_NOT_FOUND;
    wmemcpy(*block + length, authority, sizeof(authority) / sizeof(authority[0]));
    return NO_ERROR;
}

static DWORD spawn_coordinator(const wchar_t *executable, const wchar_t *entrypoint,
                               struct workbench_coordinator *coordinator) {
    wchar_t command[32768], environment[32768];
    if (swprintf(command, 32768, L"\"%ls\" \"%ls\" web-windows-system", executable, entrypoint) < 0)
        return ERROR_FILENAME_EXCED_RANGE;
    DWORD error = coordinator_environment(&environment);
    if (error)
        return error;
    SECURITY_ATTRIBUTES inherited = {sizeof(inherited), NULL, TRUE};
    HANDLE input = NULL, output = NULL, diagnostics = INVALID_HANDLE_VALUE;
    if (!CreatePipe(&input, &coordinator->commands, &inherited, 4096) ||
        !SetHandleInformation(coordinator->commands, HANDLE_FLAG_INHERIT, 0) ||
        !CreatePipe(&coordinator->replies, &output, &inherited, 4096) ||
        !SetHandleInformation(coordinator->replies, HANDLE_FLAG_INHERIT, 0))
        error = GetLastError();
    if (!error) {
        diagnostics = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  &inherited, OPEN_EXISTING, 0, NULL);
        if (diagnostics == INVALID_HANDLE_VALUE)
            error = GetLastError();
    }
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input;
    startup.StartupInfo.hStdOutput = output;
    startup.StartupInfo.hStdError = diagnostics;
    HANDLE handles[] = {input, output, diagnostics};
    LPPROC_THREAD_ATTRIBUTE_LIST list = NULL;
    if (!error) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(NULL, 1, 0, &size);
        list = HeapAlloc(GetProcessHeap(), 0, size);
        if (!list) error = ERROR_NOT_ENOUGH_MEMORY;
        else if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) error = GetLastError();
        else {
            startup.lpAttributeList = list;
            if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), NULL, NULL))
                error = GetLastError();
        }
    }
    if (!error)
        error = workbench_process_job(&coordinator->job);
    PROCESS_INFORMATION child = {0};
    if (!error && !CreateProcessW(executable, command, NULL, NULL, TRUE,
                                  CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                                  EXTENDED_STARTUPINFO_PRESENT, environment, NULL, &startup.StartupInfo, &child))
        error = GetLastError();
    if (startup.lpAttributeList) DeleteProcThreadAttributeList(startup.lpAttributeList);
    if (list) HeapFree(GetProcessHeap(), 0, list);
    if (input) CloseHandle(input);
    if (output) CloseHandle(output);
    if (diagnostics != INVALID_HANDLE_VALUE) CloseHandle(diagnostics);
    if (!error) {
        coordinator->process = child.hProcess;
        coordinator->target.process = child.dwProcessId;
        if (!AssignProcessToJobObject(coordinator->job, child.hProcess)) {
            error = GetLastError();
            TerminateProcess(child.hProcess, error);
        } else if (ResumeThread(child.hThread) == (DWORD)-1) {
            error = GetLastError();
        }
        CloseHandle(child.hThread);
    }
    return error;
}

static DWORD exchange(struct workbench_coordinator *coordinator, const char *command, BYTE *reply, DWORD *capacity) {
    size_t size = strlen(command);
    DWORD transferred = 0;
    if (size >= command_limit)
        return ERROR_INVALID_DATA;
    if (!WriteFile(coordinator->commands, command, (DWORD)size, &transferred, NULL))
        return GetLastError();
    if (transferred != size)
        return ERROR_WRITE_FAULT;
    ULONGLONG deadline = GetTickCount64() + launch_wait;
    DWORD length = 0;
    while (length < *capacity) {
        if (WaitForSingleObject(coordinator->stop, 0) == WAIT_OBJECT_0)
            return ERROR_OPERATION_ABORTED;
        if (GetTickCount64() >= deadline)
            return ERROR_TIMEOUT;
        DWORD available = 0;
        if (!PeekNamedPipe(coordinator->replies, NULL, 0, NULL, &available, NULL))
            return GetLastError();
        if (!available) {
            if (WaitForSingleObject(coordinator->process, 20) == WAIT_OBJECT_0)
                return ERROR_PROCESS_ABORTED;
            continue;
        }
        BYTE value;
        if (!ReadFile(coordinator->replies, &value, 1, &transferred, NULL))
            return GetLastError();
        if (transferred != 1)
            return ERROR_BROKEN_PIPE;
        if (value == '\n') {
            *capacity = length && reply[length - 1] == '\r' ? length - 1 : length;
            return NO_ERROR;
        }
        reply[length++] = value;
    }
    return ERROR_INSUFFICIENT_BUFFER;
}

static DWORD WINAPI relay_browser(void *state) {
    struct workbench_coordinator *coordinator = state;
    return workbench_browser_relay(coordinator->listener, coordinator->stop, &coordinator->target);
}

static DWORD WINAPI watch_coordinator(void *state) {
    const struct workbench_coordinator *coordinator = state;
    HANDLE handles[] = {coordinator->stop, coordinator->process, coordinator->relay};
    DWORD status = WaitForMultipleObjects(3, handles, FALSE, INFINITE);
    if (status == WAIT_OBJECT_0)
        return NO_ERROR;
    SetEvent(coordinator->stop);
    DWORD result = ERROR_PROCESS_ABORTED;
    if (status == WAIT_OBJECT_0 + 2) {
        DWORD reported = 0;
        if (GetExitCodeThread(coordinator->relay, &reported) && reported)
            result = reported;
    }
    return result;
}

DWORD workbench_coordinator_start(const wchar_t *executable, const wchar_t *entrypoint, USHORT port, HANDLE stop,
                                  struct workbench_coordinator *coordinator) {
    *coordinator = (struct workbench_coordinator){0};
    coordinator->stop = stop;
    coordinator->listener = INVALID_SOCKET;
    BYTE random[48];
    if (BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
        return ERROR_GEN_FAILURE;
    char nonce[33], key[65];
    workbench_hex(random, 16, nonce);
    workbench_hex(random + 16, 32, key);
    memcpy(coordinator->target.key, random + 16, sizeof(coordinator->target.key));
    SecureZeroMemory(random, sizeof(random));
    coordinator->target.pipe = coordinator->pipe;
    DWORD error = swprintf(coordinator->pipe, 128, L"\\\\.\\pipe\\Workbench-Browser-%hs", nonce) < 0
                      ? ERROR_INVALID_DATA : NO_ERROR;
    WSADATA network;
    if (!error) {
        error = WSAStartup(MAKEWORD(2, 2), &network);
        coordinator->network = !error;
    }
    if (!error)
        error = workbench_browser_listener(port, &coordinator->listener);
    if (!error)
        error = spawn_coordinator(executable, entrypoint, coordinator);
    if (!error) {
        char command[command_limit];
        int length = snprintf(command, sizeof(command), "open %u %lu %s %s\n", (unsigned)port,
                              (unsigned long)GetCurrentProcessId(), nonce, key);
        BYTE ready[64];
        DWORD capacity = sizeof(ready);
        error = length < 0 || (size_t)length >= sizeof(command) ? ERROR_INVALID_DATA :
                exchange(coordinator, command, ready, &capacity);
        SecureZeroMemory(command, sizeof(command));
        static const char accepted[] = "{\"ready\":true}";
        if (!error && (capacity != sizeof(accepted) - 1 || memcmp(ready, accepted, capacity)))
            error = ERROR_INVALID_DATA;
    }
    SecureZeroMemory(key, sizeof(key));
    if (!error)
        error = workbench_verify_pipe(coordinator->pipe, coordinator->target.process);
    if (!error) {
        coordinator->relay = CreateThread(NULL, 0, relay_browser, coordinator, 0, NULL);
        if (!coordinator->relay)
            error = GetLastError();
    }
    if (!error) {
        coordinator->watcher = CreateThread(NULL, 0, watch_coordinator, coordinator, 0, NULL);
        if (!coordinator->watcher)
            error = GetLastError();
    }
    if (error)
        workbench_coordinator_close(coordinator);
    return error;
}

DWORD workbench_coordinator_close(struct workbench_coordinator *coordinator) {
    SetEvent(coordinator->stop);
    if (coordinator->relay) {
        WaitForSingleObject(coordinator->relay, INFINITE);
        CloseHandle(coordinator->relay);
    } else if (coordinator->listener != INVALID_SOCKET) {
        closesocket(coordinator->listener);
    }
    DWORD error = NO_ERROR;
    if (coordinator->watcher) {
        WaitForSingleObject(coordinator->watcher, INFINITE);
        if (!GetExitCodeThread(coordinator->watcher, &error))
            error = GetLastError();
        CloseHandle(coordinator->watcher);
    }
    if (coordinator->commands) CloseHandle(coordinator->commands);
    if (coordinator->process) {
        DWORD stopped = WaitForSingleObject(coordinator->process, stop_wait);
        if (!error && stopped != WAIT_OBJECT_0)
            error = stopped == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
        if (coordinator->job) CloseHandle(coordinator->job);
        CloseHandle(coordinator->process);
    } else if (coordinator->job) {
        CloseHandle(coordinator->job);
    }
    if (coordinator->replies) CloseHandle(coordinator->replies);
    if (coordinator->network) WSACleanup();
    SecureZeroMemory(coordinator, sizeof(*coordinator));
    return error;
}

DWORD workbench_coordinator_attach(struct workbench_coordinator *coordinator, PSID account, const char *nonce,
                                   const char *key, BYTE *reply, DWORD *length) {
    wchar_t name[256], domain[256];
    DWORD names = sizeof(name) / sizeof(name[0]), domains = sizeof(domain) / sizeof(domain[0]);
    SID_NAME_USE kind;
    if (!LookupAccountSidW(NULL, account, name, &names, domain, &domains, &kind))
        return GetLastError();
    BYTE username[512];
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, -1, (char *)username, sizeof(username), NULL, NULL);
    if (size < 2)
        return ERROR_INVALID_ACCOUNT_NAME;
    char encoded[sizeof(username) * 2 + 1];
    workbench_hex(username, (size_t)size - 1, encoded);
    wchar_t *sid = NULL;
    if (!ConvertSidToStringSidW(account, &sid))
        return GetLastError();
    char command[command_limit];
    int bytes = snprintf(command, sizeof(command), "attach %ls %s %s %s\n", sid, encoded, nonce, key);
    LocalFree(sid);
    DWORD error = bytes > 0 && (size_t)bytes < sizeof(command) ?
                  exchange(coordinator, command, reply, length) : ERROR_INVALID_DATA;
    SecureZeroMemory(command, sizeof(command));
    if (error) SetEvent(coordinator->stop);
    return error;
}
