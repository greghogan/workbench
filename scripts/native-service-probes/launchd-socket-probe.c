#include <errno.h>
#include <launch.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int *sockets = NULL;
    size_t count = 0;
    int result = launch_activate_socket("Loopback", &sockets, &count);
    if (result || count != 2) {
        fprintf(stderr, "Expected two launchd loopback listeners, got %zu (status %d)\n", count, result);
        free(sockets);
        return EXIT_FAILURE;
    }
    struct pollfd listeners[2] = {{sockets[0], POLLIN, 0}, {sockets[1], POLLIN, 0}};
    free(sockets);
    signal(SIGPIPE, SIG_IGN);
    char identity[64];
    int length = snprintf(identity, sizeof(identity), "workbench-activation:%ld\n", (long)getpid());
    if (length < 1 || (size_t)length >= sizeof(identity))
        return EXIT_FAILURE;
    for (;;) {
        if (poll(listeners, count, -1) < 0) {
            if (errno == EINTR)
                continue;
            perror("poll launchd listeners");
            return EXIT_FAILURE;
        }
        for (size_t i = 0; i < count; i++) {
            if (!(listeners[i].revents & POLLIN))
                continue;
            int client = accept(listeners[i].fd, NULL, NULL);
            if (client < 0) {
                perror("accept launchd connection");
                return EXIT_FAILURE;
            }
            ssize_t written = write(client, identity, (size_t)length);
            close(client);
            if (written != length)
                fprintf(stderr, "Incomplete activation response\n");
        }
    }
}
