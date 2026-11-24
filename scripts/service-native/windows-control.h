#ifndef WORKBENCH_WINDOWS_CONTROL_H
#define WORKBENCH_WINDOWS_CONTROL_H

#include <windows.h>

enum { workbench_control_capacity = 1024, workbench_job_capacity = 192 };

enum workbench_control_operation {
    workbench_sign_in = 1, workbench_resume_account = 2, workbench_retire_account = 3, workbench_private_drain = 4,
    workbench_job_control = 5
};

/* Ordinary sign-in and job requests use the caller's SID. LocalSystem can request a previously authorized SID.
   A handler must finish promptly and set *length to the number of reply bytes written. */
typedef DWORD (*workbench_control_handler)(enum workbench_control_operation operation, HANDLE token, PSID sid,
                                           const char *job, void *context, BYTE *reply, DWORD *length);

/* The control pipe publishes browser readiness independently of the SCM's stoppable running state. */
DWORD workbench_control_listen(const wchar_t *service, HANDLE *listener);
DWORD workbench_control_ready(const wchar_t *service, DWORD pid, BOOL *ready);
DWORD workbench_private_listen(const wchar_t *name, const wchar_t *owner, HANDLE *listener);

/* A bad client cannot stop the service. A set stop event cancels connection and transfer. */
DWORD workbench_control_serve(HANDLE listener, HANDLE stop_event, workbench_control_handler handle, void *context,
                              PSID private_owner);

/* The client permits impersonation only after authenticating the pipe's SCM process. */
DWORD workbench_control_request(const wchar_t *service, enum workbench_control_operation operation, PSID sid,
                                BYTE reply[workbench_control_capacity], DWORD *length);
DWORD workbench_jobs_request(const wchar_t *service, const wchar_t *command,
                             BYTE reply[workbench_control_capacity], DWORD *length);
DWORD workbench_private_request(const wchar_t *name, PSID owner, DWORD expected_parent,
                                BYTE reply[workbench_control_capacity], DWORD *length);
DWORD workbench_job_observe(const wchar_t *id, const wchar_t *pid_text, const wchar_t *sid_text);
DWORD workbench_process_sid(HANDLE process, BYTE sid[SECURITY_MAX_SID_SIZE]);

#endif
