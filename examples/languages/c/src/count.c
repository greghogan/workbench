#include "count.h"
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#if (defined(__x86_64__) || defined(_M_X64)) && !defined(WORKBENCH_PORTABLE_ONLY)
#include <immintrin.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include "wb_cpu.h"
#include <intrin.h>
#endif
#define WB_HAS_AVX2 1
#else
#define WB_HAS_AVX2 0
#endif

#if WB_HAS_AVX2 && defined(_MSC_VER) && !defined(__clang__)
__declspec(noinline) size_t wb_mvsc_avx2(const uint8_t *data, size_t length, uint8_t needle);
#endif
bool wb_avx2_available(void) {
#if WB_HAS_AVX2
#if defined(_MSC_VER) && !defined(__clang__)
    int registers[4];
    __cpuid(registers, 0);
    if (registers[0] < 7) {
        return false;
    }
    __cpuidex(registers, 1, 0);
    const unsigned int leaf1 = (unsigned int)registers[2];
    if (!wb_cpu_can_read_xcr0(leaf1)) {
        return false;
    }
    struct wb_cpu_features features = {.maximum_leaf = 7U, .leaf1 = leaf1, .leaf7 = 0U, .xcr0 = _xgetbv(0)};
    if (!wb_cpu_avx_state(features)) {
        return false;
    }
    __cpuidex(registers, 7, 0);
    features.leaf7 = (unsigned int)registers[1];
    return wb_cpu_avx2_features(features);
#else
    return __builtin_cpu_supports("avx2");
#endif
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

#if WB_HAS_AVX2 && !(defined(_MSC_VER) && !defined(__clang__))
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
#if defined(_MSC_VER) && !defined(__clang__)
        *result = wb_mvsc_avx2(data, length, needle);
#else
        *result = avx2(data, length, needle);
#endif
        return true;
    }
#endif
    *result = scalar(data, length, needle);
    return true;
}
