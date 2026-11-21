#define WIN32_LEAN_AND_MEAN
#include "windows-private.h"
#include "windows-control.h"

#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tlhelp32.h>
#include <wchar.h>

struct private_reply {
    char text[workbench_control_capacity + 2];
    DWORD length;
};

static DWORD private_listener(DWORD pid, BOOL *present) {
    *present = FALSE;
    wchar_t name[96];
    if (swprintf(name, 96, L"\\\\.\\pipe\\Workbench-Private-Admission-%lu", (unsigned long)pid) < 0)
        return ERROR_INVALID_NAME;
    /* No caller data goes to a private process. The kernel supplies the server PID. */
    HANDLE pipe = CreateFileW(name, FILE_READ_ATTRIBUTES, 0, NULL, OPEN_EXISTING,
                              SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (error == ERROR_PIPE_BUSY || error == ERROR_NO_DATA) {
            *present = TRUE;
            return NO_ERROR;
        }
        return error == ERROR_FILE_NOT_FOUND ? NO_ERROR : error;
    }
    ULONG peer = 0;
    DWORD error = GetNamedPipeServerProcessId(pipe, &peer) ? NO_ERROR : GetLastError();
    CloseHandle(pipe);
    /* A close during inspection is retried before admitting the shared listener. */
    if (error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_BROKEN_PIPE) {
        *present = TRUE;
        return NO_ERROR;
    }
    *present = !error && peer == pid;
    return error;
}

static DWORD scan_private_listeners(BOOL *present) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE)
        return GetLastError();
    PROCESSENTRY32W process = {0};
    process.dwSize = sizeof(process);
    DWORD error = NO_ERROR;
    for (BOOL next = Process32FirstW(snapshot, &process);;) {
        if (!next) {
            error = GetLastError();
            if (error == ERROR_NO_MORE_FILES)
                error = NO_ERROR;
            break;
        }
        if (process.th32ProcessID && process.th32ProcessID != GetCurrentProcessId()) {
            error = private_listener(process.th32ProcessID, present);
            if (error || *present)
                break;
        }
        next = Process32NextW(snapshot, &process);
    }
    CloseHandle(snapshot);
    return error;
}

DWORD workbench_wait_for_private_listeners(HANDLE stopping) {
    for (;;) {
        BOOL present = FALSE;
        DWORD error = scan_private_listeners(&present);
        if (error)
            return error;
        DWORD observed = WaitForSingleObject(stopping, present ? 250 : 0);
        if (observed == WAIT_OBJECT_0)
            return ERROR_OPERATION_ABORTED;
        if (observed != WAIT_TIMEOUT)
            return GetLastError();
        if (!present)
            return NO_ERROR;
    }
}

DWORD workbench_private_launch(const wchar_t *node, const wchar_t *directory, wchar_t *command) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (GetFileType(input) != FILE_TYPE_PIPE)
        return ERROR_INVALID_HANDLE;
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child = {0};
    /* Do not copy other inheritable handles from a CLI started with redirected output. */
    if (!CreateProcessW(node, command, NULL, NULL, FALSE, CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
                        NULL, directory, &startup, &child))
        return GetLastError();
    CloseHandle(child.hThread);

    BOOL admitted = FALSE;
    DWORD error = ERROR_BROKEN_PIPE;
    if (printf("%lu\n", child.dwProcessId) > 0 && fflush(stdout) == 0) {
        for (;;) {
            DWORD status = WaitForSingleObject(child.hProcess, 50);
            if (status != WAIT_TIMEOUT) {
                error = status == WAIT_FAILED ? GetLastError() : ERROR_PROCESS_ABORTED;
                break;
            }
            DWORD available = 0;
            if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
                error = GetLastError();
                break;
            }
            if (available) {
                BYTE decision;
                DWORD received = 0;
                if (!ReadFile(input, &decision, sizeof(decision), &received, NULL))
                    error = GetLastError();
                else if (received == sizeof(decision) && decision == '1')
                    admitted = TRUE;
                break;
            }
        }
    }
    if (!admitted && WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT) {
        if (!TerminateProcess(child.hProcess, ERROR_CANCELLED))
            error = GetLastError();
        else if (WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0)
            error = ERROR_TIMEOUT;
    }
    CloseHandle(child.hProcess);
    return admitted ? NO_ERROR : error;
}

static DWORD private_reply(enum workbench_control_operation operation, HANDLE token, PSID peer, const char *job,
                           void *context, BYTE *reply, DWORD *length) {
    (void)job;
    (void)token;
    (void)peer;
    if (operation == workbench_private_drain) {
        reply[0] = '1';
        *length = 1;
        return NO_ERROR;
    }
    struct private_reply *value = context;
    if (*length < value->length)
        return ERROR_INSUFFICIENT_BUFFER;
    memcpy(reply, value->text, value->length);
    *length = value->length;
    return NO_ERROR;
}

static DWORD private_serve(const wchar_t *name, const wchar_t *owner, PSID sid, const wchar_t *parent) {
    wchar_t *end = NULL;
    DWORD pid = wcstoul(parent, &end, 10);
    if (!pid || *end)
        return ERROR_INVALID_PARAMETER;
    HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process)
        return GetLastError();
    BYTE observed[SECURITY_MAX_SID_SIZE];
    DWORD error = workbench_process_sid(process, observed);
    if (!error && !EqualSid(observed, sid))
        error = ERROR_ACCESS_DENIED;

    struct private_reply value = {0};
    if (!error) {
        if (!fgets(value.text, sizeof(value.text), stdin)) {
            error = ERROR_INVALID_DATA;
        } else {
            size_t length = strlen(value.text);
            if (length < 2 || value.text[length - 1] != '\n')
                error = ERROR_INVALID_DATA;
            else
                value.length = (DWORD)(length - 1);
        }
    }
    HANDLE listener = INVALID_HANDLE_VALUE;
    if (!error)
        error = workbench_private_listen(name, owner, &listener);
    if (!error && (fputs("ready\n", stdout) == EOF || fflush(stdout) == EOF))
        error = ERROR_WRITE_FAULT;
    if (!error)
        error = workbench_control_serve(listener, process, private_reply, &value, sid);
    if (listener != INVALID_HANDLE_VALUE)
        CloseHandle(listener);
    SecureZeroMemory(&value, sizeof(value));
    if (error == ERROR_CANCELLED) {
        if (fputs("drain\n", stdout) == EOF || fflush(stdout) == EOF)
            error = ERROR_WRITE_FAULT;
        else
            error = WaitForSingleObject(process, INFINITE) == WAIT_OBJECT_0 ? NO_ERROR : GetLastError();
    }
    CloseHandle(process);
    return error;
}

DWORD workbench_private_control(const wchar_t *command, const wchar_t *instance, const wchar_t *parent) {
    if (wcslen(instance) != 32 || wcsspn(instance, L"0123456789abcdef") != 32)
        return ERROR_INVALID_NAME;
    BYTE sid[SECURITY_MAX_SID_SIZE];
    DWORD error = workbench_process_sid(GetCurrentProcess(), sid);
    if (error)
        return error;
    wchar_t *owner = NULL;
    if (!ConvertSidToStringSidW(sid, &owner))
        return GetLastError();
    wchar_t name[256];
    if (swprintf(name, 256, L"\\\\.\\pipe\\Workbench-Private-%ls-%ls", owner, instance) < 0) {
        error = ERROR_INVALID_NAME;
    } else if (!wcscmp(command, L"private-listen") && parent) {
        error = private_serve(name, owner, sid, parent);
    } else if ((!wcscmp(command, L"private-read") && !parent) ||
               (!wcscmp(command, L"private-drain") && parent)) {
        wchar_t *end = NULL;
        DWORD expected = parent ? wcstoul(parent, &end, 10) : 0;
        if (parent && (!expected || *end)) {
            error = ERROR_INVALID_PARAMETER;
        } else {
            BYTE reply[workbench_control_capacity];
            DWORD length = 0;
            error = workbench_private_request(name, sid, expected, reply, &length);
            if (!error && (fwrite(reply, 1, length, stdout) != length || fputc('\n', stdout) == EOF))
                error = ERROR_WRITE_FAULT;
            SecureZeroMemory(reply, sizeof(reply));
        }
    } else {
        error = ERROR_INVALID_PARAMETER;
    }
    LocalFree(owner);
    return error;
}
