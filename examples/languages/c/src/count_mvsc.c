#include <stddef.h>
#include <stdint.h>

size_t wb_mvsc_avx2(const uint8_t *data, size_t length, uint8_t needle);
#if defined(_MSC_VER) && !defined(__clang__) && defined(_M_X64) && !defined(WORKBENCH_PORTABLE_ONLY)
#include <immintrin.h>
#include <intrin.h>
#include <string.h>
__declspec(noinline) size_t wb_mvsc_avx2(const uint8_t *data, size_t length, uint8_t needle) {
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
        count += (size_t)__popcnt(mask);
    }
    for (; index < length; ++index) {
        count += data[index] == needle ? 1U : 0U;
    }
    return count;
}
#endif
