#ifndef WORKBENCH_WINDOWS_PRIVATE_H
#define WORKBENCH_WINDOWS_PRIVATE_H

#include <windows.h>

DWORD workbench_private_control(const wchar_t *command, const wchar_t *instance, const wchar_t *parent);
DWORD workbench_private_launch(const wchar_t *node, const wchar_t *directory, wchar_t *command);
DWORD workbench_wait_for_private_listeners(HANDLE stopping);

#endif
