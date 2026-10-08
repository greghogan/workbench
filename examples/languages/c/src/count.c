#include "count.h"
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#if defined(__x86_64__) && !defined(WORKBENCH_PORTABLE_ONLY)
#include <immintrin.h>
#define WB_HAS_AVX2 1
#else
#define WB_HAS_AVX2 0
#endif

bool wb_avx2_available(void) {
#if WB_HAS_AVX2
    return __builtin_cpu_supports("avx2");
#else
    return false;
#endif
}

static size_t scalar(const uint8_t *data, size_t length, uint8_t needle) {
    size_t count = 0;
    for (size_t index = 0; index < length; ++index) {
        count += data[index] == needle ? 1U : 0U;
    }
    return count;
}

#if WB_HAS_AVX2
__attribute__((target("avx2"))) static size_t avx2(const uint8_t *data, size_t length, uint8_t needle) {
    const size_t width = 32;
    const __m256i target = _mm256_set1_epi8((char)needle);
    size_t index = 0;
    size_t count = 0;
    for (; length - index >= width; index += width) {
        /* A full vector is readable; memcpy permits unaligned input without pointer casts. */
        __m256i values;
        /* NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling) */
        memcpy(&values, data + index, sizeof values);
        const unsigned int mask = (unsigned int)_mm256_movemask_epi8(_mm256_cmpeq_epi8(values, target));
        count += (size_t)__builtin_popcount(mask);
    }
    return count + scalar(data + index, length - index, needle);
}
#endif

bool wb_count(const uint8_t *data, size_t length, uint8_t needle, wb_backend backend, size_t *result) {
    if (result == NULL || (data == NULL && length != 0) ||
        (backend != WB_AUTO && backend != WB_SCALAR && backend != WB_AVX2)) {
        return false;
    }
    const bool available = wb_avx2_available();
    if (backend == WB_AVX2 && !available) {
        return false;
    }
#if WB_HAS_AVX2
    if (backend != WB_SCALAR && available && length != 0) {
        *result = avx2(data, length, needle);
        return true;
    }
#endif
    *result = scalar(data, length, needle);
    return true;
}
