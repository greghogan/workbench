#include "count.h"
#include "count_json.h"
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    const int offset = argc == 4 && strcmp(argv[1], "--json") == 0 ? 1 : 0;
    if (argc != 3 + offset || strlen(argv[1 + offset]) != 1) {
        (void)fputs("usage: count [--json] BYTE TEXT\n", stderr);
        return 2;
    }
    size_t count = 0;
    if (!wb_count((const uint8_t *)argv[2 + offset], strlen(argv[2 + offset]), (uint8_t)argv[1 + offset][0], WB_AUTO,
                  &count)) {
        return 1;
    }
    if (offset == 1) {
        return wb_write_json_count(stdout, count, NULL);
    }
    return printf("%zu\n", count) < 0 ? 1 : 0;
}
