#ifndef WORKBENCH_COUNT_HPP
#define WORKBENCH_COUNT_HPP
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace workbench {
enum class Backend : std::uint8_t { automatic, scalar, avx2 };
[[nodiscard]] bool avx2_available() noexcept;
// Unsupported explicit backends return nullopt, including for empty input.
[[nodiscard]] std::optional<std::size_t> count_byte(std::span<const std::uint8_t> data, std::uint8_t needle,
                                                    Backend backend = Backend::automatic) noexcept;
} // namespace workbench

#endif
