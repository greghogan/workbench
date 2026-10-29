#ifndef WORKBENCH_COUNT_H
#define WORKBENCH_COUNT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum { WB_AUTO, WB_SCALAR, WB_AVX2 } wb_backend;
/* Optional implementations never execute without checking CPU and OS support. */
bool wb_avx2_available(void);
/* data points to length readable bytes, or may be NULL when length is zero.
 * Returns false for invalid arguments or an unavailable requested backend.
 * A failed call leaves result unchanged. */
bool wb_count(const uint8_t *data, size_t length, uint8_t needle, wb_backend backend, size_t *result);
#endif
