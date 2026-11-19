#ifndef WORKBENCH_WINDOWS_WORKER_H
#define WORKBENCH_WINDOWS_WORKER_H

#include <windows.h>

struct workbench_worker {
    HANDLE process;
    HANDLE job;
    HANDLE account;
    HANDLE profile;
    DWORD pid;
};

/* The SCM registration supplies protected executable and entry-point paths. */
DWORD workbench_worker_start(HANDLE caller, PSID sid, const wchar_t *executable,
                             const wchar_t *entrypoint, const wchar_t *nonce, const wchar_t *key,
                             struct workbench_worker *worker);
DWORD workbench_worker_close(struct workbench_worker *worker);
DWORD workbench_process_job(HANDLE *job);

#endif
