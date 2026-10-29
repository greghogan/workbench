#ifndef WORKBENCH_CPU_H
#define WORKBENCH_CPU_H
#include <stdbool.h>
#include <stdint.h>

static const unsigned int wb_cpu_popcnt_bit = 23U;
static const unsigned int wb_cpu_osxsave_bit = 27U;
static const unsigned int wb_cpu_avx_bit = 28U;
static const unsigned int wb_cpu_avx2_bit = 5U;
static const unsigned int wb_cpu_avx2_leaf = 7U;
static const uint64_t wb_cpu_avx_register_state = 6U;

struct wb_cpu_features {
    unsigned int maximum_leaf;
    unsigned int leaf1;
    unsigned int leaf7;
    uint64_t xcr0;
};

/* Hardware-independent predicates keep unsupported CPU/OS states testable on every host. */
static inline bool wb_cpu_can_read_xcr0(unsigned int leaf1) {
    const unsigned int required = (1U << wb_cpu_popcnt_bit) | (1U << wb_cpu_osxsave_bit) | (1U << wb_cpu_avx_bit);
    return (leaf1 & required) == required;
}
static inline bool wb_cpu_avx_state(struct wb_cpu_features features) {
    if (!wb_cpu_can_read_xcr0(features.leaf1)) {
        return false;
    }
    return (features.xcr0 & wb_cpu_avx_register_state) == wb_cpu_avx_register_state;
}
static inline bool wb_cpu_avx2_features(struct wb_cpu_features features) {
    if (features.maximum_leaf < wb_cpu_avx2_leaf || !wb_cpu_avx_state(features)) {
        return false;
    }
    return (features.leaf7 & (1U << wb_cpu_avx2_bit)) != 0U;
}
#endif
