// Fixture values deliberately exercise byte extremes and vector boundaries.
// NOLINTBEGIN(readability-magic-numbers,cppcoreguidelines-avoid-magic-numbers)
#include "count.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <span>
#include <string_view>

int main(int argc, char **argv) { // NOLINT(misc-const-correctness): standard main signature.
    const auto args = std::span(argv, static_cast<std::size_t>(argc));
    if (args.size() != 2) {
        return 2;
    }
    const std::string_view choice(args.subspan(1).front());
    auto backend = workbench::Backend::automatic;
    if (choice == "scalar") {
        backend = workbench::Backend::scalar;
    }
    if (choice == "avx2") {
        backend = workbench::Backend::avx2;
    }
    if (!workbench::avx2_available()) {
        if (workbench::count_byte({}, 0, workbench::Backend::avx2).has_value()) {
            return 1;
        }
        if (backend == workbench::Backend::avx2) {
            (void)std::puts("SKIP: AVX2 unavailable");
            return 77;
        }
    }
    std::array<std::uint8_t, 160> data{};
    std::size_t fill_index = 0;
    for (auto &value : data) {
        value = fill_index % 3 == 0 ? 255 : 0;
        ++fill_index;
    }
    constexpr std::array<std::size_t, 8> lengths{0, 1, 31, 32, 33, 63, 64, 65};
    for (std::size_t offset = 0; offset < 32; ++offset) {
        for (const auto length : lengths) {
            std::size_t expected = 0;
            for (std::size_t index = offset; index < offset + length; ++index) {
                expected += index % 3 == 0 ? 1U : 0U;
            }
            const auto slice = std::span<const std::uint8_t>(data).subspan(offset, length);
            if (workbench::count_byte(slice, 255, backend) != expected ||
                workbench::count_byte(slice, 0, backend) != length - expected ||
                workbench::count_byte(slice, 1, backend) != 0) {
                return 1;
            }
        }
    }
    return 0;
}

// NOLINTEND(readability-magic-numbers,cppcoreguidelines-avoid-magic-numbers)
