#include "count.hpp"
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <fmt/base.h>
#include <span>
#include <string_view>

int main(int argc, char **argv) { // NOLINT(misc-const-correctness): standard main signature.
    const auto args = std::span(argv, static_cast<std::size_t>(argc));
    const auto usage = [] {
        fmt::print(stderr, "usage: count [--json] BYTE TEXT\n");
        return 2;
    };
    const bool json = args.size() == 4 && std::string_view(args.subspan(1).front()) == "--json";
    const std::size_t offset = json ? 1 : 0;
    if (args.size() != 3 + offset) {
        return usage();
    }
    const std::string_view needle(args.subspan(1 + offset).front());
    if (needle.size() != 1) {
        return usage();
    }
    const std::string_view text(args.subspan(2 + offset).front());
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): character bytes are readable through uint8_t.
    const auto result = workbench::count_byte({reinterpret_cast<const std::uint8_t *>(text.data()), text.size()},
                                              static_cast<std::uint8_t>(needle.front()));
    if (!result) {
        return 1;
    }
    if (json) {
        fmt::print("{{\"count\":{}}}\n", *result);
    } else {
        fmt::print("{}\n", *result);
    }
    return 0;
}
