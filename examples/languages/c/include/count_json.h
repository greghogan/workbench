#ifndef WORKBENCH_COUNT_JSON_H
#define WORKBENCH_COUNT_JSON_H
#include <stddef.h>
#include <stdio.h>
#include <yyjson.h>

// Write one JSON count to a caller-owned stream. Return zero on success, one on allocation or write failure.
// The optional allocator and its context are borrowed for this call; NULL selects the default allocator.
int wb_write_json_count(FILE *output, size_t count, const yyjson_alc *allocator);
#endif
