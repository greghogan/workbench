#include "wb_cpu.h"
#ifdef __cplusplus
int main() {
#else
int main(void) {
#endif
    /* Architectural encodings deliberately do not reuse the decoder's constants. */
    const unsigned int popcnt = 0x00800000U;
    const unsigned int osxsave = 0x08000000U;
    const unsigned int avx = 0x10000000U;
    const unsigned int features = popcnt | osxsave | avx;
    const unsigned int avx2 = 0x20U;
    const unsigned int maximum_leaf = 7U;
    const unsigned int older_leaf = 6U;
    const struct wb_cpu_features valid = {.maximum_leaf = maximum_leaf, .leaf1 = features, .leaf7 = avx2, .xcr0 = 6U};
    if (!wb_cpu_avx2_features(valid)) {
        return 1;
    }
    struct wb_cpu_features no_popcnt = valid;
    no_popcnt.leaf1 &= ~popcnt;
    if (wb_cpu_avx2_features(no_popcnt)) {
        return 1;
    }
    struct wb_cpu_features no_osxsave = valid;
    no_osxsave.leaf1 &= ~osxsave;
    if (wb_cpu_avx2_features(no_osxsave)) {
        return 1;
    }
    struct wb_cpu_features no_avx = valid;
    no_avx.leaf1 &= ~avx;
    if (wb_cpu_avx2_features(no_avx)) {
        return 1;
    }
    struct wb_cpu_features old_cpu = valid;
    old_cpu.maximum_leaf = older_leaf;
    if (wb_cpu_avx2_features(old_cpu)) {
        return 1;
    }
    struct wb_cpu_features no_avx2 = valid;
    no_avx2.leaf7 = 0U;
    if (wb_cpu_avx2_features(no_avx2)) {
        return 1;
    }
    struct wb_cpu_features no_ymm = valid;
    no_ymm.xcr0 = 2U;
    if (wb_cpu_avx2_features(no_ymm)) {
        return 1;
    }
    struct wb_cpu_features no_xmm = valid;
    no_xmm.xcr0 = 4U;
    if (wb_cpu_avx2_features(no_xmm)) {
        return 1;
    }
    return 0;
}
