// Fixture values deliberately exercise byte extremes and vector boundaries.
// NOLINTBEGIN(readability-magic-numbers)
#include "count.h"
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static bool test_counts(wb_backend backend) {
    size_t count = 0;
    uint8_t data[160];
    for (size_t index = 0; index < sizeof(data); ++index) {
        data[index] = index % 3 == 0 ? 255 : 0;
    }
    const size_t lengths[] = {0, 1, 31, 32, 33, 63, 64, 65};
    for (size_t offset = 0; offset < 32; ++offset) {
        for (size_t item = 0; item < sizeof(lengths) / sizeof(lengths[0]); ++item) {
            const size_t length = lengths[item];
            size_t expected = 0;
            for (size_t index = offset; index < offset + length; ++index) {
                expected += index % 3 == 0 ? 1U : 0U;
            }
            if (!wb_count(data + offset, length, 255, backend, &count) || count != expected ||
                !wb_count(data + offset, length, 0, backend, &count) || count != length - expected ||
                !wb_count(data + offset, length, 1, backend, &count) || count != 0) {
                return false;
            }
        }
    }
    return true;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        return 2;
    }
    wb_backend backend = WB_AUTO;
    if (strcmp(argv[1], "scalar") == 0) {
        backend = WB_SCALAR;
    }
    if (strcmp(argv[1], "avx2") == 0) {
        backend = WB_AVX2;
    }
    size_t count = 123;
    if (!wb_avx2_available()) {
        if (wb_count(NULL, 0, 0, WB_AVX2, &count) || count != 123) {
            return 1;
        }
        if (backend == WB_AVX2) {
            puts("SKIP: AVX2 unavailable");
            return 77;
        }
    }
    if (wb_count(NULL, 1, 0, backend, &count) || count != 123 || wb_count(NULL, 0, 0, backend, NULL)) {
        return 1;
    }
    if (!wb_count(NULL, 0, 0, backend, &count) || count != 0) {
        return 1;
    }
    return test_counts(backend) ? 0 : 1;
}

// NOLINTEND(readability-magic-numbers)
