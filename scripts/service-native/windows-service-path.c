#define WIN32_LEAN_AND_MEAN
#include "windows-service-path.h"

#include <aclapi.h>
#include <sddl.h>
#include <wchar.h>
#include <wctype.h>

static BOOL administrator(PSID sid, PSID installer) {
    return IsValidSid(sid) && (IsWellKnownSid(sid, WinLocalSystemSid) ||
                              IsWellKnownSid(sid, WinBuiltinAdministratorsSid) || EqualSid(sid, installer));
}

static DWORD protected_acl(HANDLE file, DWORD writes, PSID installer) {
    PSID owner = NULL;
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    DWORD error = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                  &owner, NULL, &acl, NULL, &descriptor);
    if (error)
        return error;
    if (!owner || !acl || !administrator(owner, installer))
        error = ERROR_INVALID_OWNER;
    GENERIC_MAPPING rights = {FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    for (DWORD index = 0; !error && index < acl->AceCount; ++index) {
        void *entry;
        if (!GetAce(acl, index, &entry)) {
            error = GetLastError();
            break;
        }
        ACE_HEADER *header = entry;
        if ((header->AceFlags & INHERIT_ONLY_ACE) || header->AceType == ACCESS_DENIED_ACE_TYPE)
            continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
            error = ERROR_INVALID_ACL;
            break;
        }
        ACCESS_ALLOWED_ACE *grant = entry;
        DWORD access = grant->Mask;
        MapGenericMask(&access, &rights);
        if ((access & writes) && !administrator(&grant->SidStart, installer))
            error = ERROR_ACCESS_DENIED;
    }
    LocalFree(descriptor);
    return error;
}

static DWORD protected_entry(const wchar_t *path, BOOL directory, BOOL volume, PSID installer) {
    HANDLE entry = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (entry == INVALID_HANDLE_VALUE)
        return GetLastError();
    FILE_ATTRIBUTE_TAG_INFO attributes;
    DWORD error = NO_ERROR;
    if (!GetFileInformationByHandleEx(entry, FileAttributeTagInfo, &attributes, sizeof(attributes))) {
        error = GetLastError();
    } else if (GetFileType(entry) != FILE_TYPE_DISK ||
               (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
               !!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) {
        error = ERROR_INVALID_NAME;
    } else {
        DWORD writes = WRITE_DAC | WRITE_OWNER | DELETE | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
        if (directory)
            writes |= FILE_DELETE_CHILD;
        if (!volume)
            writes |= FILE_WRITE_DATA | FILE_APPEND_DATA;
        error = protected_acl(entry, writes, installer);
    }
    CloseHandle(entry);
    return error;
}

DWORD workbench_service_file(const wchar_t *path) {
    wchar_t prefix[32768];
    size_t length = wcslen(path);
    if (length < 4 || length >= sizeof(prefix) / sizeof(prefix[0]) ||
        !iswalpha(path[0]) || path[1] != L':' || path[2] != L'\\')
        return ERROR_INVALID_NAME;
    wmemcpy(prefix, path, 3);
    prefix[3] = 0;
    if (GetDriveTypeW(prefix) != DRIVE_FIXED)
        return ERROR_BAD_DEVICE;
    PSID installer = NULL;
    if (!ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer))
        return GetLastError();
    DWORD error = protected_entry(prefix, TRUE, TRUE, installer);
    for (size_t start = 3, end = 3; !error && end <= length; ++end) {
        wchar_t character = path[end];
        if (character == L'\\' || !character) {
            if (end == start || path[end - 1] == L'.' || path[end - 1] == L' ') {
                error = ERROR_INVALID_NAME;
                break;
            }
            prefix[end] = 0;
            error = protected_entry(prefix, character != 0, FALSE, installer);
            prefix[end] = character;
            start = end + 1;
        } else if (character < 32 || wcschr(L"\"/:<>|?*", character)) {
            error = ERROR_INVALID_NAME;
        } else {
            prefix[end] = character;
        }
    }
    LocalFree(installer);
    return error;
}
