#define _DARWIN_C_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <launch.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <syslog.h>
#include <unistd.h>

/* Reserve descriptors 3 (IPv4), 4 (IPv6) and 5 (control) for the Node supervisor.
   Node marks its inherited descriptors close-on-exec before starting workers. */
static int loopback_family(int descriptor, in_port_t port) {
    struct sockaddr_storage address = {0};
    socklen_t length = sizeof(address);
    int type = 0;
    socklen_t option_length = sizeof(type);
    if (getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &option_length) ||
        getsockname(descriptor, (struct sockaddr *)&address, &length)) {
        syslog(LOG_ERR, "Cannot inspect Workbench browser descriptor %d: %s", descriptor, strerror(errno));
        return 0;
    }
    if (type != SOCK_STREAM) {
        syslog(LOG_ERR, "Workbench browser descriptor %d is not a stream socket (type %d)", descriptor, type);
        return 0;
    }
    if (address.ss_family == AF_INET && length == sizeof(struct sockaddr_in)) {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)&address;
        if (ipv4->sin_port == port && ipv4->sin_addr.s_addr == htonl(INADDR_LOOPBACK))
            return AF_INET;
    }
    if (address.ss_family == AF_INET6 && length == sizeof(struct sockaddr_in6)) {
        const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)&address;
        if (ipv6->sin6_port == port && IN6_IS_ADDR_LOOPBACK(&ipv6->sin6_addr))
            return AF_INET6;
    }
    syslog(LOG_ERR, "Workbench browser descriptor %d is not the configured loopback endpoint (family %u, length %u)",
           descriptor, (unsigned)address.ss_family, (unsigned)length);
    return 0;
}

static bool is_control(int descriptor, const char *expected) {
    struct sockaddr_un address = {0};
    socklen_t length = sizeof(address);
    int type = 0;
    socklen_t option_length = sizeof(type);
    if (getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &option_length) ||
        getsockname(descriptor, (struct sockaddr *)&address, &length)) {
        syslog(LOG_ERR, "Cannot inspect Workbench control descriptor %d: %s", descriptor, strerror(errno));
        return false;
    }
    if (type == SOCK_STREAM && address.sun_family == AF_UNIX &&
        strnlen(expected, sizeof(address.sun_path)) < sizeof(address.sun_path) &&
        !strncmp(address.sun_path, expected, sizeof(address.sun_path)))
        return true;
    syslog(LOG_ERR, "Unexpected Workbench control descriptor %d (family %u, type %d, path '%.*s')",
           descriptor, (unsigned)address.sun_family, type, (int)sizeof(address.sun_path), address.sun_path);
    return false;
}

static bool install_descriptors(const int *browser, const int *control, in_port_t port, const char *path) {
    int descriptors[3] = {browser[0], browser[1], control[0]};
    const int family = loopback_family(descriptors[0], port);
    if (family == AF_INET6) {
        descriptors[0] = browser[1];
        descriptors[1] = browser[0];
    }
    if (loopback_family(descriptors[0], port) != AF_INET ||
        loopback_family(descriptors[1], port) != AF_INET6 || !is_control(descriptors[2], path))
        return false;
    int copies[3];
    for (size_t i = 0; i < 3; i++) {
        if (descriptors[i] < 3) {
            syslog(LOG_ERR, "Workbench received an unexpected standard descriptor %d", descriptors[i]);
            return false;
        }
        copies[i] = fcntl(descriptors[i], F_DUPFD_CLOEXEC, 6);
        if (copies[i] < 0) {
            syslog(LOG_ERR, "Cannot duplicate Workbench descriptor %d: %s", descriptors[i], strerror(errno));
            return false;
        }
    }
    for (size_t i = 0; i < 3; i++)
        close(descriptors[i]);
    for (int i = 0; i < 3; i++) {
        if (dup2(copies[i], i + 3) != i + 3) {
            syslog(LOG_ERR, "Cannot pass Workbench listener %d to Node: %s", i + 3, strerror(errno));
            return false;
        }
        close(copies[i]);
    }
    return true;
}

int main(int argc, char *argv[]) {
    openlog("workbench-launchd", LOG_PID | LOG_PERROR, LOG_DAEMON);
    if (argc != 5 || getuid() || geteuid() || argv[1][0] != '/' || argv[2][0] != '/') {
        syslog(LOG_ERR, "The Workbench launcher requires the installed system daemon and absolute launch paths");
        return EXIT_FAILURE;
    }
    char *end;
    errno = 0;
    const long port = strtol(argv[3], &end, 10);
    if (errno || *end || port < 1 || port > 65535) {
        syslog(LOG_ERR, "The Workbench launcher requires a fixed loopback port");
        return EXIT_FAILURE;
    }
    int *browser = NULL, *control = NULL;
    size_t count = 0, controls = 0;
    const int result = launch_activate_socket("Loopback", &browser, &count);
    const int control_result = launch_activate_socket("Control", &control, &controls);
    const bool activated = !result && count == 2 && !control_result && controls == 1 &&
                           install_descriptors(browser, control, htons((in_port_t)port), argv[4]);
    free(browser);
    free(control);
    if (!activated) {
        syslog(LOG_ERR, "The Workbench launcher could not adopt the sockets (browser status %d, count %zu; control status %d, count %zu)",
               result, count, control_result, controls);
        return EXIT_FAILURE;
    }
    if (setenv("WORKBENCH_LAUNCHD_SOCKET_ACTIVATED", "1", 1)) {
        syslog(LOG_ERR, "The Workbench launcher could not prepare Node's environment: %s", strerror(errno));
        return EXIT_FAILURE;
    }
    char *const command[] = {argv[1], argv[2], "serve", "--service", "--host", "127.0.0.1", "--port", argv[3], NULL};
    execv(argv[1], command);
    syslog(LOG_ERR, "The Workbench launcher could not start Node: %s", strerror(errno));
    return EXIT_FAILURE;
}
