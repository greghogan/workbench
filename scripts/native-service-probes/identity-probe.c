#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <userenv.h>
#include <stdio.h>
#include <wchar.h>

static wchar_t *service_name, *directory, *first_sid, *second_sid;
static SERVICE_STATUS_HANDLE status_handle;
static HANDLE stop_event, service_thread;

enum failure_stage {
    SCM_CONNECTION = 1, SCM_SERVICE, SCM_STATUS, PIPE_OPEN, PIPE_PEER, PIPE_IO,
    PIPE_IMPERSONATION, CLIENT_TOKEN, PRIMARY_TOKEN, WORKER_ENVIRONMENT, WORKER_PROCESS,
    WORKER_PROFILE, WORKER_PROJECT, WORKER_ISOLATION
};
static const char *const stages[] = {
    "argument or service", "connect to SCM", "open SCM service", "query SCM service",
    "open control pipe", "verify SCM peer", "exchange pipe request", "impersonate pipe client",
    "read client token", "duplicate primary token", "load worker environment", "start worker",
    "verify worker identity or profile", "read worker project", "verify worker isolation"
};

/* An exit code carries the failing step alongside a Win32 status through the worker and pipe. */
static DWORD at_stage(enum failure_stage stage, DWORD result) {
    return result ? ((DWORD)stage << 24) | (result & 0xffffffUL) : NO_ERROR;
}

static DWORD process_sid(HANDLE token, wchar_t **sid) {
    union { TOKEN_USER header; BYTE bytes[512]; } info;
    DWORD length = 0;
    if (!GetTokenInformation(token, TokenUser, &info, sizeof(info), &length))
        return GetLastError();
    if (!ConvertSidToStringSidW(info.header.User.Sid, sid))
        return GetLastError();
    return NO_ERROR;
}

static DWORD path_for(wchar_t path[32768], const wchar_t *root, const wchar_t *sid) {
    return swprintf(path, 32768, L"%ls\\%ls\\fixture.txt", root, sid) < 0
        ? ERROR_FILENAME_EXCED_RANGE : NO_ERROR;
}

static DWORD check_worker(const wchar_t *root, const wchar_t *own, const wchar_t *other) {
    HANDLE token;
    wchar_t *actual = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return at_stage(WORKER_PROFILE, GetLastError());
    DWORD result = process_sid(token, &actual);
    wchar_t profile[32768], environment_profile[32768];
    DWORD capacity = 32768;
    if (!result && !GetUserProfileDirectoryW(token, profile, &capacity))
        result = GetLastError();
    CloseHandle(token);
    if (!result && wcscmp(actual, own))
        result = ERROR_INVALID_OWNER;
    if (actual)
        LocalFree(actual);
    if (result)
        return at_stage(WORKER_PROFILE, result);
    capacity = GetEnvironmentVariableW(L"USERPROFILE", environment_profile, 32768);
    if (!capacity || capacity >= 32768 || _wcsicmp(profile, environment_profile))
        return at_stage(WORKER_PROFILE, ERROR_INVALID_DATA);
    wchar_t path[32768];
    if ((result = path_for(path, root, own)) != NO_ERROR)
        return at_stage(WORKER_PROJECT, result);
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE)
        return at_stage(WORKER_PROJECT, GetLastError());
    char marker;
    DWORD read = 0;
    BOOL opened = ReadFile(file, &marker, 1, &read, NULL);
    CloseHandle(file);
    if (!opened || read != 1 || marker != 'W')
        return at_stage(WORKER_PROJECT, ERROR_INVALID_DATA);

    if ((result = path_for(path, root, other)) != NO_ERROR)
        return at_stage(WORKER_ISOLATION, result);
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        CloseHandle(file);
        return at_stage(WORKER_ISOLATION, ERROR_INVALID_ACCESS);
    }
    return GetLastError() == ERROR_ACCESS_DENIED ? NO_ERROR : at_stage(WORKER_ISOLATION, ERROR_INVALID_DATA);
}

static DWORD launch_worker(HANDLE token, const wchar_t *sid) {
    const wchar_t *other;
    if (!wcscmp(sid, first_sid))
        other = second_sid;
    else if (!wcscmp(sid, second_sid))
        other = first_sid;
    else
        return at_stage(CLIENT_TOKEN, ERROR_ACCESS_DENIED);
    wchar_t executable[32768], command[32768];
    DWORD length = GetModuleFileNameW(NULL, executable, 32768);
    if (!length || length == 32768 || swprintf(command, 32768, L"\"%ls\" worker \"%ls\" %ls %ls",
                                                 executable, directory, sid, other) < 0)
        return ERROR_FILENAME_EXCED_RANGE;
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child = {0};
    LPVOID environment = NULL;
    if (!CreateEnvironmentBlock(&environment, token, FALSE))
        return at_stage(WORKER_ENVIRONMENT, GetLastError());
    BOOL started = CreateProcessAsUserW(token, executable, command, NULL, NULL, FALSE,
                                       CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, environment,
                                       directory, &startup, &child);
    DWORD start_error = started ? NO_ERROR : GetLastError();
    DestroyEnvironmentBlock(environment);
    if (!started)
        return at_stage(WORKER_PROCESS, start_error);
    CloseHandle(child.hThread);
    DWORD result = ERROR_PROCESS_ABORTED;
    if (WaitForSingleObject(child.hProcess, 10000) == WAIT_OBJECT_0) {
        if (!GetExitCodeProcess(child.hProcess, &result))
            result = GetLastError();
    } else {
        TerminateProcess(child.hProcess, ERROR_TIMEOUT);
        WaitForSingleObject(child.hProcess, 5000);
        result = ERROR_TIMEOUT;
    }
    CloseHandle(child.hProcess);
    return result;
}

static DWORD answer(HANDLE pipe) {
    HANDLE caller = NULL, worker = NULL;
    wchar_t *sid = NULL;
    BYTE operation;
    DWORD length = 0;
    if (!ReadFile(pipe, &operation, 1, &length, NULL))
        return GetLastError();
    if (length != 1 || operation != 1)
        return ERROR_INVALID_DATA;
    if (!ImpersonateNamedPipeClient(pipe))
        return at_stage(PIPE_IMPERSONATION, GetLastError());

    DWORD result = NO_ERROR;
    if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_DUPLICATE, TRUE, &caller))
        result = at_stage(CLIENT_TOKEN, GetLastError());
    else if ((result = at_stage(CLIENT_TOKEN, process_sid(caller, &sid))) == NO_ERROR &&
             !DuplicateTokenEx(caller, MAXIMUM_ALLOWED, NULL, SecurityImpersonation, TokenPrimary, &worker))
        result = at_stage(PRIMARY_TOKEN, GetLastError());
    if (!RevertToSelf())
        ExitProcess(GetLastError());
    if (!result)
        result = launch_worker(worker, sid);
    if (worker)
        CloseHandle(worker);
    if (caller)
        CloseHandle(caller);
    if (sid)
        LocalFree(sid);
    return result;
}

static void service_status(DWORD state, DWORD result) {
    SERVICE_STATUS status = {0};
    status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    status.dwCurrentState = state;
    status.dwWin32ExitCode = result;
    status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP : 0;
    SetServiceStatus(status_handle, &status);
}

static DWORD WINAPI service_control(DWORD control, DWORD event, void *data, void *context) {
    (void)event;
    (void)data;
    (void)context;
    if (control != SERVICE_CONTROL_STOP)
        return ERROR_CALL_NOT_IMPLEMENTED;
    service_status(SERVICE_STOP_PENDING, NO_ERROR);
    SetEvent(stop_event);
    CancelSynchronousIo(service_thread);
    return NO_ERROR;
}

static BOOL pipe_path(wchar_t destination[256], const wchar_t *name) {
    return swprintf(destination, 256, L"\\\\.\\pipe\\%ls", name) > 0;
}

static void WINAPI serve(DWORD argc, wchar_t **argv) {
    (void)argc;
    (void)argv;
    status_handle = RegisterServiceCtrlHandlerExW(service_name, service_control, NULL);
    if (!status_handle)
        return;
    service_status(SERVICE_START_PENDING, NO_ERROR);
    stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    wchar_t name[256];
    PSECURITY_DESCRIPTOR descriptor = NULL;
    SECURITY_ATTRIBUTES security = {sizeof(security), NULL, FALSE};
    HANDLE pipe = INVALID_HANDLE_VALUE;
    DWORD result = NO_ERROR;
    if (!stop_event ||
        !DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &service_thread,
                         0, FALSE, DUPLICATE_SAME_ACCESS) ||
        !ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x100003;;;AU)", SDDL_REVISION_1, &descriptor, NULL)) {
        result = GetLastError();
    } else if (!pipe_path(name, service_name)) {
        result = ERROR_INVALID_NAME;
    } else {
        security.lpSecurityDescriptor = descriptor;
        pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS,
                                1, 512, 512, 5000, &security);
        if (pipe == INVALID_HANDLE_VALUE)
            result = GetLastError();
    }
    if (pipe != INVALID_HANDLE_VALUE) {
        service_status(SERVICE_RUNNING, NO_ERROR);
        while (WaitForSingleObject(stop_event, 0) == WAIT_TIMEOUT) {
            if (!ConnectNamedPipe(pipe, NULL)) {
                DWORD error = GetLastError();
                if (error != ERROR_PIPE_CONNECTED) {
                    if (WaitForSingleObject(stop_event, 0) != WAIT_OBJECT_0)
                        result = error;
                    break;
                }
            }
            DWORD response = answer(pipe), written = 0;
            if (WriteFile(pipe, &response, sizeof(response), &written, NULL))
                FlushFileBuffers(pipe);
            DisconnectNamedPipe(pipe);
        }
        CloseHandle(pipe);
    }
    if (descriptor)
        LocalFree(descriptor);
    if (service_thread)
        CloseHandle(service_thread);
    if (stop_event)
        CloseHandle(stop_event);
    service_status(SERVICE_STOPPED, result);
}

static DWORD request(const wchar_t *service) {
    wchar_t name[256];
    if (!pipe_path(name, service))
        return ERROR_INVALID_NAME;
    SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
    if (!manager)
        return at_stage(SCM_CONNECTION, GetLastError());
    SC_HANDLE registration = OpenServiceW(manager, service, SERVICE_QUERY_STATUS);
    SERVICE_STATUS_PROCESS status;
    DWORD length = 0, result = NO_ERROR;
    if (!registration)
        result = at_stage(SCM_SERVICE, GetLastError());
    else if (!QueryServiceStatusEx(registration, SC_STATUS_PROCESS_INFO, (BYTE *)&status, sizeof(status), &length))
        result = at_stage(SCM_STATUS, GetLastError());
    else if (status.dwCurrentState != SERVICE_RUNNING)
        result = ERROR_SERVICE_NOT_ACTIVE;
    else {
        HANDLE pipe = CreateFileW(name, FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, 0, NULL, OPEN_EXISTING,
                                  SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION, NULL);
        if (pipe == INVALID_HANDLE_VALUE)
            result = at_stage(PIPE_OPEN, GetLastError());
        else {
            ULONG peer = 0;
            BYTE operation = 1;
            DWORD response = ERROR_INVALID_DATA;
            if (!GetNamedPipeServerProcessId(pipe, &peer) || peer != status.dwProcessId)
                result = at_stage(PIPE_PEER, ERROR_INVALID_OWNER);
            else if (!WriteFile(pipe, &operation, 1, &length, NULL) || length != 1 ||
                     !ReadFile(pipe, &response, sizeof(response), &length, NULL) || length != sizeof(response))
                result = at_stage(PIPE_IO, ERROR_INVALID_DATA);
            else
                result = response;
            CloseHandle(pipe);
        }
    }
    if (registration)
        CloseServiceHandle(registration);
    CloseServiceHandle(manager);
    return result;
}

int wmain(int argc, wchar_t **argv) {
    DWORD result = ERROR_INVALID_PARAMETER;
    if (argc == 6 && !wcscmp(argv[1], L"service")) {
        service_name = argv[2];
        directory = argv[3];
        first_sid = argv[4];
        second_sid = argv[5];
        SERVICE_TABLE_ENTRYW table[] = {{service_name, serve}, {NULL, NULL}};
        result = StartServiceCtrlDispatcherW(table) ? NO_ERROR : GetLastError();
    } else if (argc == 3 && !wcscmp(argv[1], L"request")) {
        result = request(argv[2]);
    } else if (argc == 5 && !wcscmp(argv[1], L"worker")) {
        result = check_worker(argv[2], argv[3], argv[4]);
    }
    if (result) {
        const DWORD stage = result >> 24;
        const char *name = stage < sizeof(stages) / sizeof(stages[0]) ? stages[stage] : "worker exit";
        fprintf(stderr, "Windows account-worker probe could not %s (%lu)\n", name,
                (unsigned long)(stage < sizeof(stages) / sizeof(stages[0]) ? result & 0xffffffUL : result));
    }
    return (int)result;
}
