#include "count_json.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <yyjson.h>

_Static_assert(SIZE_MAX <= UINT64_MAX, "JSON counts require size_t to fit in uint64_t");

int wb_write_json_count(FILE *output, size_t count, const yyjson_alc *allocator) {
    yyjson_mut_doc *document = yyjson_mut_doc_new(allocator);
    if (document == NULL) {
        return 1;
    }
    yyjson_mut_val *object = yyjson_mut_obj(document);
    // add_uint also rejects NULL if creating the object failed.
    if (!yyjson_mut_obj_add_uint(document, object, "count", (uint64_t)count)) {
        yyjson_mut_doc_free(document);
        return 1;
    }
    yyjson_mut_doc_set_root(document, object);
    const bool success = yyjson_mut_write_fp(output, document, YYJSON_WRITE_NEWLINE_AT_END, allocator, NULL);
    yyjson_mut_doc_free(document);
    return success ? 0 : 1;
}
