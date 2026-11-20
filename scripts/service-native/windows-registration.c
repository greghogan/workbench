#define WIN32_LEAN_AND_MEAN
#include "windows-registration.h"

#include "windows-service-path.h"
#include <iphlpapi.h>
#include <wchar.h>

static const wchar_t reservation_name[] = L"WorkbenchPortReservation";

static DWORD read_owned_reservation(HKEY registration, USHORT port, ULONG64 *owner) {
    DWORD size = sizeof(*owner);
    LSTATUS result = RegGetValueW(registration, NULL, reservation_name, RRF_RT_REG_QWORD, NULL, owner, &size);
    if (result)
        return (DWORD)result;
    ULONG64 found = 0;
    DWORD error = LookupPersistentTcpPortReservation(htons(port), 1, &found);
    return error ? error : found == *owner ? NO_ERROR : ERROR_INVALID_OWNER;
}

static DWORD owned_service(SC_HANDLE service, const wchar_t *command, HKEY registration, USHORT port) {
    union {
        QUERY_SERVICE_CONFIGW definition;
        BYTE storage[8192];
    } saved;
    DWORD used = 0;
    if (!QueryServiceConfigW(service, &saved.definition, sizeof(saved), &used))
        return GetLastError();
    if (saved.definition.dwServiceType != SERVICE_WIN32_OWN_PROCESS ||
        saved.definition.dwStartType != SERVICE_AUTO_START ||
        wcscmp(saved.definition.lpBinaryPathName, command) ||
        _wcsicmp(saved.definition.lpServiceStartName, L"LocalSystem"))
        return ERROR_INVALID_OWNER;
    ULONG64 owner;
    return read_owned_reservation(registration, port, &owner);
}

static DWORD service_key(const wchar_t *name, HKEY *registration) {
    wchar_t key[128];
    if (swprintf(key, 128, L"SYSTEM\\CurrentControlSet\\Services\\%ls", name) < 0)
        return ERROR_INVALID_NAME;
    return (DWORD)RegOpenKeyExW(HKEY_LOCAL_MACHINE, key, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, registration);
}

static DWORD register_service(SC_HANDLE manager, const wchar_t *name, const wchar_t *command, USHORT port) {
    ULONG64 owner = 0;
    DWORD error = CreatePersistentTcpPortReservation(htons(port), 1, &owner);
    if (error)
        return error;
    SC_HANDLE created = CreateServiceW(manager, name, name, DELETE | SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS,
                                       SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, command,
                                       NULL, NULL, NULL, NULL, NULL);
    if (!created) {
        error = GetLastError();
        DeletePersistentTcpPortReservation(htons(port), 1);
        return error;
    }
    HKEY receipt;
    error = service_key(name, &receipt);
    if (!error) {
        error = (DWORD)RegSetValueExW(receipt, reservation_name, 0, REG_QWORD, (const BYTE *)&owner, sizeof(owner));
        if (!error)
            error = (DWORD)RegFlushKey(receipt);
        RegCloseKey(receipt);
    }
    if (error) {
        DeleteService(created);
        DeletePersistentTcpPortReservation(htons(port), 1);
    }
    CloseServiceHandle(created);
    return error;
}

static DWORD unregister_service(SC_HANDLE service, HKEY registration, USHORT port) {
    SERVICE_STATUS_PROCESS current;
    DWORD required;
    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&current, sizeof(current), &required))
        return GetLastError();
    if (current.dwCurrentState != SERVICE_STOPPED)
        return ERROR_SERVICE_CANNOT_ACCEPT_CTRL;
    ULONG64 owner;
    DWORD error = read_owned_reservation(registration, port, &owner);
    if (error)
        return error;
    error = DeletePersistentTcpPortReservation(htons(port), 1);
    if (error)
        return error;
    if (!DeleteService(service)) {
        error = GetLastError();
        if (!CreatePersistentTcpPortReservation(htons(port), 1, &owner)) {
            RegSetValueExW(registration, reservation_name, 0, REG_QWORD, (const BYTE *)&owner, sizeof(owner));
            RegFlushKey(registration);
        }
    }
    return error;
}

DWORD workbench_registration(const wchar_t *operation, const wchar_t *name, const wchar_t *worker_runtime,
                             const wchar_t *launcher, USHORT port) {
    size_t length = wcslen(name);
    if (!length || length > 64 ||
        wcsspn(name, L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-") != length)
        return ERROR_INVALID_NAME;
    wchar_t executable[32768], command[32768];
    DWORD characters = GetModuleFileNameW(NULL, executable, 32768);
    if (!characters || characters >= 32768)
        return ERROR_INVALID_NAME;
    DWORD error = workbench_service_file(executable);
    if (!error)
        error = workbench_service_file(worker_runtime);
    if (!error)
        error = workbench_service_file(launcher);
    if (error)
        return error;
    if (swprintf(command, 32768, L"\"%ls\" service %ls \"%ls\" \"%ls\" %u",
                 executable, name, worker_runtime, launcher, (unsigned)port) < 0)
        return ERROR_INVALID_NAME;

    BOOL removing = !wcscmp(operation, L"unregister");
    BOOL registering = !wcscmp(operation, L"register");
    BOOL starting = !wcscmp(operation, L"start");
    BOOL stopping = !wcscmp(operation, L"stop");
    SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT | (registering ? SC_MANAGER_CREATE_SERVICE : 0));
    if (!manager)
        return GetLastError();
    DWORD access = SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | (removing ? DELETE : 0) |
                   (starting ? SERVICE_START : 0) | (stopping ? SERVICE_STOP : 0);
    SC_HANDLE service = OpenServiceW(manager, name, access);
    if (!service) {
        error = GetLastError();
        if (error == ERROR_SERVICE_DOES_NOT_EXIST && (removing || registering))
            error = removing ? NO_ERROR : register_service(manager, name, command, port);
    } else {
        HKEY registration;
        error = service_key(name, &registration);
        if (!error) {
            error = owned_service(service, command, registration, port);
            if (!error && removing)
                error = unregister_service(service, registration, port);
            if (!error && starting && !StartServiceW(service, 0, NULL)) {
                error = GetLastError();
                if (error == ERROR_SERVICE_ALREADY_RUNNING)
                    error = NO_ERROR;
            }
            if (!error && stopping) {
                SERVICE_STATUS observed;
                if (!ControlService(service, SERVICE_CONTROL_STOP, &observed)) {
                    error = GetLastError();
                    if (error == ERROR_SERVICE_NOT_ACTIVE)
                        error = NO_ERROR;
                }
            }
            RegCloseKey(registration);
        }
        CloseServiceHandle(service);
    }
    CloseServiceHandle(manager);
    return error;
}
