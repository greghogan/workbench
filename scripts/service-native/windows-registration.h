#ifndef WORKBENCH_WINDOWS_REGISTRATION_H
#define WORKBENCH_WINDOWS_REGISTRATION_H

#include <winsock2.h>
#include <windows.h>

DWORD workbench_registration(const wchar_t *operation, const wchar_t *name, const wchar_t *worker_runtime,
                             const wchar_t *launcher, USHORT port);

#endif
