#define WIN32_LEAN_AND_MEAN
#include "windows-worker.h"

#include <userenv.h>
#include <stdlib.h>
#include <wchar.h>

enum { path_capacity = 32768, retirement_wait = 5000 };

DWORD workbench_process_job(HANDLE *job) {
    *job = CreateJobObjectW(NULL, NULL);
    if (!*job)
        return GetLastError();
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(*job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        DWORD error = GetLastError();
        CloseHandle(*job);
        *job = NULL;
        return error;
    }
    return NO_ERROR;
}

static const wchar_t nonce_variable[] = L"WORKBENCH_WINDOWS_ACCOUNT_PIPE=";
static const wchar_t key_variable[] = L"WORKBENCH_WINDOWS_ACCOUNT_KEY=";

struct environment_entry {
    const wchar_t *value;
};

static int environment_order(const void *left, const void *right) {
    const struct environment_entry *first = left, *second = right;
    return _wcsicmp(first->value, second->value);
}

static DWORD worker_environment(const wchar_t *from, const wchar_t *nonce, const wchar_t *key,
                                wchar_t **result, size_t *capacity) {
    wchar_t pipe_entry[128], key_entry[128];
    if (swprintf(pipe_entry, 128, L"%ls%ls", nonce_variable, nonce) < 0 ||
        swprintf(key_entry, 128, L"%ls%ls", key_variable, key) < 0)
        return ERROR_INVALID_DATA;
    struct environment_entry items[1024] = {{pipe_entry}, {key_entry}};
    size_t count = 2, length = 1 + wcslen(pipe_entry) + 1 + wcslen(key_entry) + 1;
    for (const wchar_t *entry = from; *entry; entry += wcslen(entry) + 1) {
        if (!_wcsnicmp(entry, nonce_variable, wcslen(nonce_variable)) ||
            !_wcsnicmp(entry, key_variable, wcslen(key_variable)) ||
            !_wcsnicmp(entry, L"NODE_OPTIONS=", 13) || !_wcsnicmp(entry, L"NODE_PATH=", 10))
            continue;
        if (count == sizeof(items) / sizeof(items[0])) {
            SecureZeroMemory(key_entry, sizeof(key_entry));
            return ERROR_ENVVAR_NOT_FOUND;
        }
        items[count++].value = entry;
        length += wcslen(entry) + 1;
    }
    qsort(items, count, sizeof(items[0]), environment_order);
    *result = calloc(length, sizeof(wchar_t));
    if (!*result) {
        SecureZeroMemory(key_entry, sizeof(key_entry));
        return ERROR_NOT_ENOUGH_MEMORY;
    }
    wchar_t *destination = *result;
    for (size_t index = 0; index < count; ++index) {
        size_t characters = wcslen(items[index].value) + 1;
        wmemcpy(destination, items[index].value, characters);
        destination += characters;
    }
    *capacity = length * sizeof(wchar_t);
    SecureZeroMemory(key_entry, sizeof(key_entry));
    return NO_ERROR;
}

/* The worker always starts in its own profile and receives only the account's environment. */
static DWORD worker_profile(HANDLE account, PSID sid, HANDLE *profile) {
    wchar_t name[256], domain[256];
    DWORD names = sizeof(name) / sizeof(name[0]), domains = sizeof(domain) / sizeof(domain[0]);
    SID_NAME_USE kind = SidTypeUnknown;
    if (!LookupAccountSidW(NULL, sid, name, &names, domain, &domains, &kind))
        return GetLastError();
    if (kind != SidTypeUser)
        return ERROR_INVALID_ACCOUNT_NAME;

    HANDLE authority;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &authority))
        return GetLastError();
    struct {
        DWORD PrivilegeCount;
        LUID_AND_ATTRIBUTES Privileges[2];
    } requested = {0}, previous = {0};
    requested.PrivilegeCount = 2;
    requested.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    requested.Privileges[1].Attributes = SE_PRIVILEGE_ENABLED;
    DWORD error = NO_ERROR;
    DWORD saved = sizeof(previous);
    if (!LookupPrivilegeValueW(NULL, L"SeBackupPrivilege", &requested.Privileges[0].Luid) ||
        !LookupPrivilegeValueW(NULL, L"SeRestorePrivilege", &requested.Privileges[1].Luid) ||
        !AdjustTokenPrivileges(authority, FALSE, (TOKEN_PRIVILEGES *)&requested, sizeof(previous),
                               (TOKEN_PRIVILEGES *)&previous, &saved)) {
        error = GetLastError();
    } else {
        error = GetLastError();
        if (!error) {
            PROFILEINFOW options = {0};
            options.dwSize = sizeof(options);
            options.dwFlags = PI_NOUI;
            options.lpUserName = name;
            if (LoadUserProfileW(account, &options))
                *profile = options.hProfile;
            else
                error = GetLastError();
        }
        if (!AdjustTokenPrivileges(authority, FALSE, (TOKEN_PRIVILEGES *)&previous, 0, NULL, NULL) ||
            GetLastError() != NO_ERROR) {
            error = GetLastError();
            /* The broker must not continue with privileges left enabled. */
            TerminateProcess(GetCurrentProcess(), error);
        }
    }
    CloseHandle(authority);
    return error;
}

DWORD workbench_worker_close(struct workbench_worker *worker) {
    DWORD error = NO_ERROR;
    ULONGLONG deadline = GetTickCount64() + retirement_wait;
    if (worker->job) {
        if (!TerminateJobObject(worker->job, ERROR_PROCESS_ABORTED)) {
            error = GetLastError();
        } else {
            for (;;) {
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION members;
                if (!QueryInformationJobObject(worker->job, JobObjectBasicAccountingInformation,
                                                &members, sizeof(members), NULL)) {
                    error = GetLastError();
                    break;
                }
                if (!members.ActiveProcesses)
                    break;
                if (GetTickCount64() >= deadline) {
                    error = ERROR_TIMEOUT;
                    break;
                }
                Sleep(10);
            }
        }
        CloseHandle(worker->job);
    }
    if (worker->process) {
        ULONGLONG now = GetTickCount64();
        DWORD stopped = WaitForSingleObject(worker->process, now < deadline ? (DWORD)(deadline - now) : 0);
        if (!error && stopped != WAIT_OBJECT_0)
            error = stopped == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
        CloseHandle(worker->process);
    }
    if (!error && worker->profile && !UnloadUserProfile(worker->account, worker->profile))
        error = GetLastError();
    if (worker->account)
        CloseHandle(worker->account);
    *worker = (struct workbench_worker){0};
    return error;
}

DWORD workbench_worker_start(HANDLE caller, PSID sid, const wchar_t *executable,
                             const wchar_t *entrypoint, const wchar_t *nonce, const wchar_t *key,
                             struct workbench_worker *worker) {
    *worker = (struct workbench_worker){0};
    if (!DuplicateTokenEx(caller, TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                          NULL, SecurityImpersonation, TokenPrimary, &worker->account))
        return GetLastError();
    DWORD error = worker_profile(worker->account, sid, &worker->profile);
    wchar_t home[path_capacity], command[path_capacity];
    DWORD capacity = path_capacity;
    if (!error && !GetUserProfileDirectoryW(worker->account, home, &capacity))
        error = GetLastError();
    if (!error && swprintf(command, path_capacity, L"\"%ls\" \"%ls\"%ls", executable, entrypoint,
                           nonce ? L" web-windows-account" : L"") < 0)
        error = ERROR_FILENAME_EXCED_RANGE;
    LPVOID environment = NULL;
    if (!error && !CreateEnvironmentBlock(&environment, worker->account, FALSE))
        error = GetLastError();

    wchar_t *scoped = NULL;
    size_t environment_bytes = 0;
    if (!error && nonce)
        error = worker_environment(environment, nonce, key, &scoped, &environment_bytes);
    if (!error)
        error = workbench_process_job(&worker->job);
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child = {0};
    if (!error &&
        !CreateProcessAsUserW(worker->account, executable, command, NULL, NULL, FALSE,
                              CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                              scoped ? scoped : environment, home, &startup, &child))
        error = GetLastError();
    if (environment)
        DestroyEnvironmentBlock(environment);
    if (scoped) {
        SecureZeroMemory(scoped, environment_bytes);
        free(scoped);
    }

    if (!error) {
        worker->process = child.hProcess;
        worker->pid = child.dwProcessId;
        if (!AssignProcessToJobObject(worker->job, child.hProcess)) {
            error = GetLastError();
            TerminateProcess(child.hProcess, error);
        } else if (ResumeThread(child.hThread) == (DWORD)-1) {
            error = GetLastError();
        }
        CloseHandle(child.hThread);
    }
    if (error)
        workbench_worker_close(worker);
    return error;
}
