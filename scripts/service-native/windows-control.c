#define WIN32_LEAN_AND_MEAN
#include "windows-control.h"

#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <tlhelp32.h>
#include <wchar.h>

enum { pipe_name_capacity = 128, maximum_wait = 5000, maximum_reply_wait = 60000 };
static const BYTE request_prefix[] = {'W', 'B', 1};
static const DWORD client_access = FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

struct control_reply {
    DWORD status;
    DWORD length;
    BYTE bytes[workbench_control_capacity];
};

static DWORD pipe_name(const wchar_t *service, wchar_t name[pipe_name_capacity]) {
    size_t length = wcslen(service);
    if (length == 0 || length > 64 ||
        wcsspn(service, L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-") != length)
        return ERROR_INVALID_NAME;
    if (swprintf(name, pipe_name_capacity, L"\\\\.\\pipe\\Workbench-Service-%ls", service) < 0)
        return ERROR_INVALID_NAME;
    return NO_ERROR;
}

static DWORD control_listener(const wchar_t *name, const wchar_t *access, HANDLE *listener) {
    *listener = INVALID_HANDLE_VALUE;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            access, SDDL_REVISION_1, &descriptor, NULL))
        return GetLastError();
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    *listener = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                 PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS, 1,
                                 sizeof(struct control_reply), sizeof(request_prefix) + 1 + SECURITY_MAX_SID_SIZE,
                                 maximum_wait, &security);
    DWORD error = *listener == INVALID_HANDLE_VALUE ? GetLastError() : NO_ERROR;
    LocalFree(descriptor);
    return error;
}

DWORD workbench_control_listen(const wchar_t *service, HANDLE *listener) {
    wchar_t name[pipe_name_capacity];
    DWORD error = pipe_name(service, name);
    /* Authenticated callers can transfer data without creating another pipe instance. */
    return error ? error : control_listener(name, L"O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x100083;;;AU)", listener);
}

DWORD workbench_control_ready(const wchar_t *service, DWORD pid, BOOL *ready) {
    *ready = FALSE;
    wchar_t name[pipe_name_capacity];
    DWORD error = pipe_name(service, name);
    if (error)
        return error;
    HANDLE pipe = CreateFileW(name, client_access, 0, NULL, OPEN_EXISTING,
                              SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PIPE_BUSY ? NO_ERROR : error;
    }
    ULONG peer = 0;
    error = GetNamedPipeServerProcessId(pipe, &peer) ? NO_ERROR : GetLastError();
    CloseHandle(pipe);
    if (!error && peer != pid)
        error = ERROR_INVALID_OWNER;
    *ready = !error;
    return error;
}

DWORD workbench_private_listen(const wchar_t *name, const wchar_t *owner, HANDLE *listener) {
    wchar_t access[512];
    if (swprintf(access, 512, L"O:%lsD:P(A;;GA;;;SY)(A;;GA;;;%ls)", owner, owner) < 0)
        return ERROR_INVALID_SID;
    return control_listener(name, access, listener);
}

static DWORD time_left(ULONGLONG deadline) {
    ULONGLONG now = GetTickCount64();
    return deadline > now ? (DWORD)(deadline - now) : 0;
}

static DWORD await_io(HANDLE pipe, OVERLAPPED *io, HANDLE stop_event, DWORD timeout, DWORD *received) {
    HANDLE events[] = {io->hEvent, stop_event};
    DWORD ready = WaitForMultipleObjects(stop_event ? 2 : 1, events, FALSE, timeout);
    if (ready == WAIT_OBJECT_0)
        return GetOverlappedResult(pipe, io, received, FALSE) ? NO_ERROR : GetLastError();
    DWORD error = ready == WAIT_FAILED ? GetLastError() :
                  ready == WAIT_TIMEOUT ? ERROR_TIMEOUT : ERROR_OPERATION_ABORTED;
    /* Pending I/O owns the OVERLAPPED and buffer until completion, including after cancellation. */
    CancelIoEx(pipe, io);
    GetOverlappedResult(pipe, io, received, TRUE);
    return error;
}

static DWORD transfer(HANDLE pipe, HANDLE stop_event, ULONGLONG deadline, BYTE *bytes, DWORD length,
                      BOOL writing) {
    OVERLAPPED io = {0};
    io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!io.hEvent)
        return GetLastError();
    DWORD error = NO_ERROR;
    while (length && !error) {
        DWORD received = 0;
        BOOL stopping = stop_event && WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0;
        if (stopping || !time_left(deadline)) {
            error = stopping ? ERROR_OPERATION_ABORTED : ERROR_TIMEOUT;
            break;
        }
        ResetEvent(io.hEvent);
        BOOL done = writing ? WriteFile(pipe, bytes, length, &received, &io) :
                    ReadFile(pipe, bytes, length, &received, &io);
        if (!done) {
            error = GetLastError();
            if (error == ERROR_IO_PENDING)
                error = await_io(pipe, &io, stop_event, time_left(deadline), &received);
        }
        if (!error && !received)
            error = ERROR_BROKEN_PIPE;
        if (!error) {
            bytes += received;
            length -= received;
        }
    }
    CloseHandle(io.hEvent);
    return error;
}

static DWORD connect_client(HANDLE pipe, HANDLE stop_event) {
    OVERLAPPED io = {0};
    io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!io.hEvent)
        return GetLastError();
    DWORD error = NO_ERROR;
    if (!ConnectNamedPipe(pipe, &io)) {
        error = GetLastError();
        if (error == ERROR_PIPE_CONNECTED)
            error = NO_ERROR;
        else if (error == ERROR_IO_PENDING) {
            DWORD received = 0;
            error = await_io(pipe, &io, stop_event, INFINITE, &received);
        }
    }
    CloseHandle(io.hEvent);
    return error;
}

static BOOL account_operation(enum workbench_control_operation operation) {
    return operation == workbench_resume_account || operation == workbench_retire_account;
}

static BOOL valid_job_command(const char job[workbench_job_capacity]) {
    size_t length = 0;
    while (length < workbench_job_capacity && job[length]) {
        char character = job[length++];
        if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == ' '))
            return FALSE;
    }
    return length > 0 && length < workbench_job_capacity;
}

static DWORD authorize_caller(HANDLE pipe, workbench_control_handler handle,
                              enum workbench_control_operation operation, PSID requested_sid, const char *job,
                              void *context, struct control_reply *reply, PSID private_owner) {
    if (!ImpersonateNamedPipeClient(pipe))
        return GetLastError();
    HANDLE token = NULL;
    DWORD access = TOKEN_QUERY | (private_owner ? 0 : TOKEN_DUPLICATE);
    DWORD error = OpenThreadToken(GetCurrentThread(), access, TRUE, &token)
                      ? NO_ERROR : GetLastError();
    if (!RevertToSelf()) {
        error = GetLastError();
        /* A service thread must never continue handling requests as the previous caller. */
        TerminateProcess(GetCurrentProcess(), error);
        return error;
    }
    if (error)
        return error;

    union {
        TOKEN_USER user;
        BYTE storage[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
    } identity;
    TOKEN_ELEVATION elevation = {0};
    SECURITY_IMPERSONATION_LEVEL level;
    DWORD required = 0;
    if (!GetTokenInformation(token, TokenUser, &identity, sizeof(identity), &required) ||
        (!private_owner && !GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &required)) ||
        !GetTokenInformation(token, TokenImpersonationLevel, &level, sizeof(level), &required)) {
        error = GetLastError();
    } else if (!IsValidSid(identity.user.User.Sid)) {
        error = ERROR_ACCESS_DENIED;
    } else if (private_owner) {
        error = ERROR_ACCESS_DENIED;
        if ((operation == workbench_sign_in || operation == workbench_private_drain) && level >= SecurityIdentification &&
            EqualSid(private_owner, identity.user.User.Sid)) {
            reply->length = sizeof(reply->bytes);
            error = handle(operation, NULL, identity.user.User.Sid, NULL, context, reply->bytes, &reply->length);
        }
    } else if (level != SecurityImpersonation) {
        error = ERROR_ACCESS_DENIED;
    } else if (account_operation(operation)) {
        error = ERROR_ACCESS_DENIED;
        if (IsWellKnownSid(identity.user.User.Sid, WinLocalSystemSid) && IsValidSid(requested_sid)) {
            reply->length = sizeof(reply->bytes);
            error = handle(operation, NULL, requested_sid, NULL, context, reply->bytes, &reply->length);
        }
    } else if (elevation.TokenIsElevated || IsWellKnownSid(identity.user.User.Sid, WinLocalSystemSid) ||
               IsWellKnownSid(identity.user.User.Sid, WinLocalServiceSid) ||
               IsWellKnownSid(identity.user.User.Sid, WinNetworkServiceSid)) {
        error = ERROR_ACCESS_DENIED;
    } else {
        reply->length = sizeof(reply->bytes);
        error = handle(operation, token, identity.user.User.Sid, job, context, reply->bytes, &reply->length);
    }
    if (!error && (!reply->length || reply->length > sizeof(reply->bytes)))
        error = ERROR_INVALID_DATA;
    CloseHandle(token);
    return error;
}

DWORD workbench_control_serve(HANDLE listener, HANDLE stop_event, workbench_control_handler handle, void *context,
                              PSID private_owner) {
    for (;;) {
        if (WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0)
            return NO_ERROR;
        DWORD error = connect_client(listener, stop_event);
        if (error && error != ERROR_NO_DATA && error != ERROR_PIPE_NOT_CONNECTED)
            return error == ERROR_OPERATION_ABORTED ? NO_ERROR : error;
        ULONGLONG deadline = GetTickCount64() + maximum_wait;
        BYTE request[sizeof(request_prefix) + 1];
        if (!error)
            error = transfer(listener, stop_event, deadline, request, sizeof(request), FALSE);
        enum workbench_control_operation operation = error ? 0 : request[sizeof(request_prefix)];
        BOOL drain = FALSE;
        if (!error && !memcmp(request, request_prefix, sizeof(request_prefix)) &&
            (operation == workbench_sign_in || (private_owner ? operation == workbench_private_drain
                                                             : account_operation(operation) ||
                                                               operation == workbench_job_control)) &&
            WaitForSingleObject(stop_event, 0) != WAIT_OBJECT_0) {
            struct control_reply reply = {0};
            BYTE sid[SECURITY_MAX_SID_SIZE] = {0};
            char job[workbench_job_capacity] = {0};
            if (account_operation(operation))
                reply.status = transfer(listener, stop_event, deadline, sid, sizeof(sid), FALSE);
            if (operation == workbench_job_control) {
                reply.status = transfer(listener, stop_event, deadline, (BYTE *)job, sizeof(job), FALSE);
                if (!reply.status && !valid_job_command(job))
                    reply.status = ERROR_INVALID_DATA;
            }
            if (!reply.status)
                reply.status = authorize_caller(listener, handle, operation, sid,
                                                operation == workbench_job_control ? job : NULL,
                                                context, &reply, private_owner);
            if (reply.status)
                reply.length = 0;
            deadline = GetTickCount64() + maximum_wait;
            error = transfer(listener, stop_event, deadline, (BYTE *)&reply,
                             (DWORD)offsetof(struct control_reply, bytes) + reply.length, TRUE);
            /* Disconnect discards unread pipe data. Wait for the client's acknowledgment with the same deadline. */
            BYTE acknowledgment = 0;
            if (!error)
                error = transfer(listener, stop_event, deadline, &acknowledgment, sizeof(acknowledgment), FALSE);
            drain = !error && !reply.status && acknowledgment == 1 && operation == workbench_private_drain;
            SecureZeroMemory(&reply, sizeof(reply));
        }
        if (!DisconnectNamedPipe(listener) && GetLastError() != ERROR_PIPE_NOT_CONNECTED)
            return GetLastError();
        if (drain)
            return ERROR_CANCELLED;
    }
}

static DWORD service_process(SC_HANDLE registration, DWORD *pid) {
    SERVICE_STATUS_PROCESS status = {0};
    DWORD required = 0;
    if (!QueryServiceStatusEx(registration, SC_STATUS_PROCESS_INFO, (BYTE *)&status, sizeof(status), &required))
        return GetLastError();
    if (status.dwCurrentState != SERVICE_RUNNING || !status.dwProcessId)
        return ERROR_SERVICE_NOT_ACTIVE;
    if (!(status.dwServiceType & SERVICE_WIN32_OWN_PROCESS))
        return ERROR_INVALID_OWNER;
    *pid = status.dwProcessId;
    return NO_ERROR;
}

static DWORD open_control(SC_HANDLE registration, const wchar_t *name, ULONGLONG deadline, HANDLE *pipe) {
    DWORD before = 0, after = 0;
    DWORD error = service_process(registration, &before);
    if (error)
        return error;
    for (;;) {
        /* A server can impersonate only the caller who sent its last read message. Verify before writing. */
        *pipe = CreateFileW(name, client_access, 0, NULL, OPEN_EXISTING,
                            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION, NULL);
        if (*pipe != INVALID_HANDLE_VALUE)
            break;
        error = GetLastError();
        if (error != ERROR_PIPE_BUSY)
            return error;
        DWORD remaining = time_left(deadline);
        if (!remaining)
            return ERROR_TIMEOUT;
        if (!WaitNamedPipeW(name, remaining))
            return GetLastError();
    }
    ULONG peer = 0;
    if (!GetNamedPipeServerProcessId(*pipe, &peer))
        return GetLastError();
    error = service_process(registration, &after);
    if (error)
        return error;
    return peer == before && peer == after ? NO_ERROR : ERROR_INVALID_OWNER;
}

static DWORD exchange_control(HANDLE pipe, ULONGLONG deadline, enum workbench_control_operation operation, PSID sid,
                              const char *job, BYTE reply[workbench_control_capacity], DWORD *length) {
    BYTE request[sizeof(request_prefix) + 1];
    memcpy(request, request_prefix, sizeof(request_prefix));
    request[sizeof(request_prefix)] = (BYTE)operation;
    DWORD error = transfer(pipe, NULL, deadline, request, sizeof(request), TRUE);
    if (!error && account_operation(operation)) {
        BYTE account[SECURITY_MAX_SID_SIZE] = {0};
        if (!sid || !CopySid(sizeof(account), account, sid))
            error = sid ? GetLastError() : ERROR_INVALID_SID;
        else
            error = transfer(pipe, NULL, deadline, account, sizeof(account), TRUE);
    }
    if (!error && operation == workbench_job_control)
        error = transfer(pipe, NULL, deadline, (BYTE *)job, workbench_job_capacity, TRUE);
    DWORD header[2];
    if (!error)
        error = transfer(pipe, NULL, deadline, (BYTE *)header, sizeof(header), FALSE);
    if (!error && (header[1] > workbench_control_capacity || (!!header[0] == !!header[1])))
        error = ERROR_INVALID_DATA;
    if (!error)
        error = transfer(pipe, NULL, deadline, reply, header[1], FALSE);
    BYTE acknowledgment = 1;
    if (!error)
        error = transfer(pipe, NULL, deadline, &acknowledgment, sizeof(acknowledgment), TRUE);
    if (error) {
        SecureZeroMemory(reply, workbench_control_capacity);
        return error;
    }
    *length = header[1];
    return header[0];
}

static DWORD control_request(const wchar_t *service, enum workbench_control_operation operation, PSID sid,
                             const char *job, BYTE reply[workbench_control_capacity], DWORD *length) {
    *length = 0;
    wchar_t name[pipe_name_capacity];
    DWORD error = pipe_name(service, name);
    if (error)
        return error;
    SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
    if (!manager)
        return GetLastError();
    SC_HANDLE registration = OpenServiceW(manager, service, SERVICE_QUERY_STATUS);
    if (!registration) {
        error = GetLastError();
    } else {
        HANDLE pipe = INVALID_HANDLE_VALUE;
        ULONGLONG deadline = GetTickCount64() + maximum_reply_wait;
        error = open_control(registration, name, deadline, &pipe);
        if (!error)
            error = exchange_control(pipe, deadline, operation, sid, job, reply, length);
        if (pipe != INVALID_HANDLE_VALUE)
            CloseHandle(pipe);
        CloseServiceHandle(registration);
    }
    CloseServiceHandle(manager);
    return error;
}

DWORD workbench_control_request(const wchar_t *service, enum workbench_control_operation operation, PSID sid,
                                BYTE reply[workbench_control_capacity], DWORD *length) {
    return control_request(service, operation, sid, NULL, reply, length);
}

DWORD workbench_jobs_request(const wchar_t *service, const wchar_t *command,
                             BYTE reply[workbench_control_capacity], DWORD *length) {
    char job[workbench_job_capacity] = {0};
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, command, -1, job, sizeof(job), NULL, NULL) ||
        !valid_job_command(job))
        return ERROR_INVALID_PARAMETER;
    return control_request(service, workbench_job_control, NULL, job, reply, length);
}

DWORD workbench_process_sid(HANDLE process, BYTE sid[SECURITY_MAX_SID_SIZE]) {
    HANDLE token;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token))
        return GetLastError();
    union {
        TOKEN_USER user;
        BYTE storage[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
    } identity;
    DWORD size;
    DWORD error = GetTokenInformation(token, TokenUser, &identity, sizeof(identity), &size) &&
                  CopySid(SECURITY_MAX_SID_SIZE, sid, identity.user.User.Sid) ? NO_ERROR : GetLastError();
    CloseHandle(token);
    return error;
}

DWORD workbench_job_observe(const wchar_t *id, const wchar_t *pid_text, const wchar_t *sid_text) {
    if (wcslen(id) != 32 || wcsspn(id, L"0123456789abcdef") != 32)
        return ERROR_INVALID_PARAMETER;
    size_t digits = wcslen(pid_text);
    if (!digits || digits > 10 || wcsspn(pid_text, L"0123456789") != digits)
        return ERROR_INVALID_PARAMETER;
    unsigned long long pid = _wcstoui64(pid_text, NULL, 10);
    if (!pid || pid > MAXDWORD)
        return ERROR_INVALID_PARAMETER;
    BYTE self[SECURITY_MAX_SID_SIZE];
    DWORD error = workbench_process_sid(GetCurrentProcess(), self);
    if (error)
        return error;
    if (!IsWellKnownSid(self, WinLocalSystemSid))
        return ERROR_ACCESS_DENIED;

    PSID owner = NULL;
    if (!ConvertStringSidToSidW(sid_text, &owner))
        return GetLastError();
    unsigned long long creation = 0;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
    if (!process) {
        error = GetLastError();
        if (error == ERROR_INVALID_PARAMETER)
            error = NO_ERROR; /* No process has the saved identifier. */
    } else {
        DWORD state = WaitForSingleObject(process, 0);
        if (state == WAIT_TIMEOUT) {
            BYTE controller[SECURITY_MAX_SID_SIZE];
            error = workbench_process_sid(process, controller);
            if (!error && EqualSid(owner, controller)) {
                FILETIME birth, exit_time, kernel, user;
                if (!GetProcessTimes(process, &birth, &exit_time, &kernel, &user))
                    error = GetLastError();
                else
                    creation = ((unsigned long long)birth.dwHighDateTime << 32) | birth.dwLowDateTime;
            }
        } else if (state != WAIT_OBJECT_0) {
            error = GetLastError();
        }
        CloseHandle(process);
    }

    BOOL present = FALSE;
    DWORD active = 0;
    if (!error) {
        wchar_t name[64];
        if (swprintf(name, sizeof(name) / sizeof(name[0]), L"Global\\Workbench-Check-%ls", id) < 0) {
            error = ERROR_INVALID_PARAMETER;
        } else {
            HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY | READ_CONTROL, FALSE, name);
            if (!job) {
                error = GetLastError();
                if (error == ERROR_FILE_NOT_FOUND)
                    error = NO_ERROR;
            } else {
                PSID observed = NULL;
                PSECURITY_DESCRIPTOR security = NULL;
                error = GetSecurityInfo(job, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, &observed,
                                        NULL, NULL, NULL, &security);
                if (!error && (!observed || !EqualSid(owner, observed)))
                    error = ERROR_INVALID_OWNER;
                if (!error) {
                    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
                    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                                   sizeof(accounting), NULL))
                        error = GetLastError();
                    else {
                        present = TRUE;
                        active = accounting.ActiveProcesses;
                    }
                }
                if (security)
                    LocalFree(security);
                CloseHandle(job);
            }
        }
    }
    LocalFree(owner);
    if (!error && printf("{\"creation\":\"%llu\",\"present\":%s,\"active\":%lu}\n",
                         creation, present ? "true" : "false", (unsigned long)active) < 0)
        error = ERROR_WRITE_FAULT;
    return error;
}

static DWORD verify_parent(DWORD process, DWORD parent) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE)
        return GetLastError();
    PROCESSENTRY32W entry = {0};
    entry.dwSize = sizeof(entry);
    DWORD result = ERROR_INVALID_OWNER;
    for (BOOL found = Process32FirstW(snapshot, &entry); found; found = Process32NextW(snapshot, &entry)) {
        if (entry.th32ProcessID == process) {
            if (entry.th32ParentProcessID == parent)
                result = NO_ERROR;
            break;
        }
    }
    CloseHandle(snapshot);
    return result;
}

DWORD workbench_private_request(const wchar_t *name, PSID owner, DWORD expected_parent,
                                BYTE reply[workbench_control_capacity], DWORD *length) {
    *length = 0;
    ULONGLONG deadline = GetTickCount64() + maximum_wait;
    HANDLE pipe;
    for (;;) {
        pipe = CreateFileW(name, client_access, 0, NULL, OPEN_EXISTING,
                           FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
        if (pipe != INVALID_HANDLE_VALUE)
            break;
        DWORD error = GetLastError();
        if (error != ERROR_PIPE_BUSY)
            return error;
        DWORD remaining = time_left(deadline);
        if (!remaining)
            return ERROR_TIMEOUT;
        if (!WaitNamedPipeW(name, remaining))
            return GetLastError();
    }
    ULONG peer;
    DWORD error = NO_ERROR;
    if (!GetNamedPipeServerProcessId(pipe, &peer))
        error = GetLastError();
    HANDLE process = error ? NULL : OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, peer);
    if (!error && !process)
        error = GetLastError();
    BYTE observed[SECURITY_MAX_SID_SIZE];
    if (!error)
        error = workbench_process_sid(process, observed);
    if (!error && !EqualSid(owner, observed))
        error = ERROR_ACCESS_DENIED;
    if (!error && expected_parent)
        error = verify_parent(peer, expected_parent);
    if (!error)
        error = exchange_control(pipe, deadline, expected_parent ? workbench_private_drain : workbench_sign_in,
                                 NULL, NULL, reply, length);
    if (process)
        CloseHandle(process);
    CloseHandle(pipe);
    return error;
}
