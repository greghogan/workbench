#include <cstddef>
#include <cstdint>
#include <span>

namespace workbench {
std::size_t mvsc_avx2(std::span<const std::uint8_t> data, std::uint8_t needle) noexcept;
} // namespace workbench
#if defined(_MSC_VER) && !defined(__clang__) && defined(_M_X64) && !defined(WORKBENCH_PORTABLE_ONLY)
#include <algorithm>
#include <bit>
#include <immintrin.h>
namespace workbench {
__declspec(noinline) std::size_t mvsc_avx2(std::span<const std::uint8_t> data, std::uint8_t needle) noexcept {
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
    return count + static_cast<std::size_t>(std::ranges::count(data, needle));
}
} // namespace workbench
#endif
