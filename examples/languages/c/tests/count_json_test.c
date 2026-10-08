#include "count_json.h"
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <yyjson.h>

// Each call owns its allocation state; no process-global hooks are needed.
typedef struct {
    size_t attempts;
    size_t fail_at;
    size_t live;
} allocation_state;

static void *tracked_allocate(void *context, size_t bytes) {
    allocation_state *state = context;
    ++state->attempts;
    if (state->attempts == state->fail_at) {
        return NULL;
    }
    void *allocation = malloc(bytes);
    if (allocation != NULL) {
        ++state->live;
    }
    return allocation;
}

// yyjson fixes the callback parameter types and order.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
static void tracked_free(void *context, void *allocation) {
    allocation_state *state = context;
    if (allocation != NULL) {
        if (state->live == 0) {
            abort();
        }
        --state->live;
    }
    free(allocation);
}

// yyjson fixes the callback parameter types and order.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
static void *tracked_reallocate(void *context, void *allocation, size_t old_size, size_t bytes) {
    // Retaining a larger block satisfies a shrink request without another allocation.
    if (allocation != NULL && bytes <= old_size) {
        return allocation;
    }
    if (allocation == NULL) {
        return tracked_allocate(context, bytes);
    }
    allocation_state *state = context;
    ++state->attempts;
    return state->attempts == state->fail_at ? NULL : realloc(allocation, bytes);
}

static int check_failures(FILE *output, FILE *read_only) {
    allocation_state state = {0};
    const yyjson_alc allocator = {
        .malloc = tracked_allocate,
        .realloc = tracked_reallocate,
        .free = tracked_free,
        .ctx = &state,
    };
    if (wb_write_json_count(output, SIZE_MAX, &allocator) != 0 || state.live != 0 || state.attempts == 0) {
        return 1;
    }
    const size_t allocations = state.attempts;
    const long successful_length = ftell(output);
    if (successful_length <= 0 || fseek(output, 0, SEEK_SET) != 0) {
        return 1;
    }
    // Decimal digits need no more space than the value's bit width; include JSON framing and the terminator.
    enum { json_capacity = sizeof("{\"count\":}\n") + (sizeof(size_t) * CHAR_BIT) };
    char expected[json_capacity];
    char actual[json_capacity];
    // Annex K is optional; this standard bounded formatter checks its capacity and result.
    // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
    const int expected_length = snprintf(expected, sizeof(expected), "{\"count\":%zu}\n", SIZE_MAX);
    if (expected_length <= 0 || (size_t)expected_length >= sizeof(expected) ||
        fgets(actual, sizeof(actual), output) == NULL || strcmp(actual, expected) != 0 || fgetc(output) != EOF ||
        fseek(output, 0, SEEK_END) != 0) {
        return 1;
    }
    for (size_t failure = 1; failure <= allocations; ++failure) {
        state.attempts = 0;
        state.fail_at = failure;
        if (wb_write_json_count(output, SIZE_MAX, &allocator) == 0 || state.live != 0 ||
            ftell(output) != successful_length) {
            return 1;
        }
    }
    state.fail_at = 0;
    // A read-only stream exercises a real write error without a platform-specific device or full disk.
    return wb_write_json_count(read_only, 0, &allocator) != 0 && ferror(read_only) != 0 && state.live == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        return 2;
    }
    FILE *output = tmpfile();
    if (output == NULL) {
        return 1;
    }
    FILE *read_only = fopen(argv[1], "r");
    if (read_only == NULL) {
        (void)fclose(output);
        return 1;
    }
    const int result = check_failures(output, read_only);
    (void)fclose(output);
    (void)fclose(read_only);
    return result;
}
