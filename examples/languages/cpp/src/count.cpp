#include "count.hpp"
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#if (defined(__x86_64__) || defined(_M_X64)) && !defined(WORKBENCH_PORTABLE_ONLY)
#include <bit>
#include <immintrin.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include "wb_cpu.h"
#include <intrin.h>
#endif
#define WB_HAS_AVX2 1 // NOLINT(cppcoreguidelines-macro-usage): used in preprocessing.
#else
#define WB_HAS_AVX2 0 // NOLINT(cppcoreguidelines-macro-usage): used in preprocessing.
#endif
namespace workbench {
#if WB_HAS_AVX2 && defined(_MSC_VER) && !defined(__clang__)
__declspec(noinline) std::size_t mvsc_avx2(std::span<const std::uint8_t> data, std::uint8_t needle) noexcept;
#endif
bool avx2_available() noexcept {
#if WB_HAS_AVX2
#if defined(_MSC_VER) && !defined(__clang__)
    int registers[4];
    __cpuid(registers, 0);
    if (registers[0] < 7) {
        return false;
    }
    __cpuidex(registers, 1, 0);
    const unsigned int leaf1 = std::bit_cast<unsigned int>(registers[2]);
    if (!wb_cpu_can_read_xcr0(leaf1)) {
        return false;
    }
    struct wb_cpu_features features = {.maximum_leaf = 7U, .leaf1 = leaf1, .leaf7 = 0U, .xcr0 = _xgetbv(0)};
    if (!wb_cpu_avx_state(features)) {
        return false;
    }
    __cpuidex(registers, 7, 0);
    features.leaf7 = std::bit_cast<unsigned int>(registers[1]);
    return wb_cpu_avx2_features(features);
#else
    return __builtin_cpu_supports("avx2");
#endif
#else
    return false;
#endif
}
namespace {
std::size_t scalar(std::span<const std::uint8_t> data, std::uint8_t needle) noexcept {
    return static_cast<std::size_t>(std::ranges::count(data, needle));
}
#if WB_HAS_AVX2 && !(defined(_MSC_VER) && !defined(__clang__))
__attribute__((target("avx2"))) std::size_t avx2(std::span<const std::uint8_t> data, std::uint8_t needle) noexcept {
    constexpr std::size_t width = 32;
    const auto target = _mm256_set1_epi8(std::bit_cast<char>(needle));
    std::size_t count = 0;
    while (data.size() >= width) {
        // A full vector is readable; loadu permits unaligned input. Only checked dispatch calls this function.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): intrinsic reads an unaligned byte vector.
        const auto values = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(data.data()));
        const auto mask = static_cast<unsigned int>(_mm256_movemask_epi8(_mm256_cmpeq_epi8(values, target)));
        count += static_cast<std::size_t>(std::popcount(mask));
        data = data.subspan(width);
    }
    return count + scalar(data, needle);
}
#endif
} // namespace
std::optional<std::size_t> count_byte(std::span<const std::uint8_t> data, std::uint8_t needle,
                                      Backend backend) noexcept {
    const bool available = avx2_available();
    if (backend == Backend::avx2 && !available) {
        return std::nullopt;
    }
#if WB_HAS_AVX2
    if (backend != Backend::scalar && available) {
#if defined(_MSC_VER) && !defined(__clang__)
        return mvsc_avx2(data, needle);
#else
        return avx2(data, needle);
#endif
    }
#endif
    return scalar(data, needle);
}
} // namespace workbench
