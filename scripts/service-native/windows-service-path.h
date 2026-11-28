#ifndef WORKBENCH_WINDOWS_SERVICE_PATH_H
#define WORKBENCH_WINDOWS_SERVICE_PATH_H

#include <windows.h>

/* Verify an absolute, administrator-owned payload and its local, protected ancestry. */
DWORD workbench_service_file(const wchar_t *path);

#endif
